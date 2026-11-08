#include "sandbox.h"
#include "cgroup_manager.h"
#include "json.hpp"
#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <atomic>
#include <csignal>
#include <sys/wait.h>
#include <sys/resource.h>
#include <unistd.h>
#include <cstring>
#include <cstdlib>
#include <cctype>
#include <chrono>
#include <filesystem>

using json = nlohmann::json;
namespace fs = std::filesystem;

static std::atomic<bool> g_running{true};
void signal_handler(int) { g_running.store(false); }

struct EvalTask {
    std::string task_id;
    std::string problem_data;
    std::string user_binary;
    std::vector<std::string> args;
    std::string stdin_file;
    uint32_t cpu_limit_ms;
    uint64_t mem_limit_bytes;
    int64_t max_pids;
    std::string expected_output_file;
    std::string checker;   // diff（默认，输出比对）/ exitcode（SPJ：退出码 0=AC）
};

// task_id 会拼进 /tmp 目录名，限制字符集，避免 ../ 之类穿越出工作目录
static bool valid_task_id(const std::string& id) {
    if (id.empty() || id.size() > 64) return false;
    for (char c : id) {
        unsigned char u = static_cast<unsigned char>(c);
        if (!(std::isalnum(u) || c == '_' || c == '-')) return false;
    }
    return true;
}

// 默认清理每个任务的临时目录；排查现场时设 KEEP_EVAL_TMP=1 保留
static void cleanup_tmp(const std::string& dir) {
    if (getenv("KEEP_EVAL_TMP") != nullptr) return;
    std::error_code ec;
    fs::remove_all(dir, ec);
}

// cgroup v2 的 OOM 计数：命中说明进程是被内存限制杀掉的，应判 MLE 而非 RE
static uint64_t read_oom_kills(const std::string& cg_path) {
    std::ifstream f(cg_path + "/memory.events");
    std::string key;
    uint64_t val = 0;
    while (f >> key >> val) {
        if (key == "oom_kill") return val;
    }
    return 0;
}

EvalTask parse_task(const std::string& body) {
    auto j = json::parse(body);
    EvalTask t;
    t.task_id         = j.at("task_id").get<std::string>();
    if (!valid_task_id(t.task_id))
        throw std::runtime_error("invalid task_id: allowed [A-Za-z0-9_-], max 64 chars");
    t.user_binary     = j.at("user_binary").get<std::string>();
    t.problem_data    = j.value("problem_data", "");
    t.cpu_limit_ms    = j.value("cpu_limit_ms", 1000u);
    t.mem_limit_bytes = j.value("mem_limit_bytes", 256ULL * 1024 * 1024);
    t.max_pids        = j.value("max_pids", 64LL);
    t.stdin_file      = j.value("stdin_file", "");
    t.expected_output_file = j.value("expected_output_file", "");
    t.checker         = j.value("checker", "diff");
    if (j.contains("args")) {
        for (auto& a : j["args"]) {
            t.args.push_back(a.get<std::string>());
        }
    }
    return t;
}

// 与客户端 judge.cpp 的 normalize 保持一致：去 UTF-8 BOM、去 \r、去行尾空白、去末尾空行。
static std::string normalize_text(const std::string& raw) {
    std::string s = raw;
    if (s.size() >= 3 && (unsigned char)s[0] == 0xEF &&
        (unsigned char)s[1] == 0xBB && (unsigned char)s[2] == 0xBF)
        s = s.substr(3);
    std::string noCR;
    for (char c : s) if (c != '\r') noCR += c;
    std::istringstream iss(noCR);
    std::string line;
    std::vector<std::string> lines;
    while (std::getline(iss, line)) {
        while (!line.empty() && (line.back() == ' ' || line.back() == '\t'))
            line.pop_back();
        lines.push_back(line);
    }
    while (!lines.empty() && lines.back().empty()) lines.pop_back();
    std::string out;
    for (auto& l : lines) out += l + "\n";
    return out;
}

static bool read_text_file(const std::string& path, std::string& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open()) return false;
    std::stringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

static bool compare_output(const std::string& actual_file, const std::string& expected_file) {
    std::string a, e;
    if (!read_text_file(actual_file, a) || !read_text_file(expected_file, e)) return false;
    return normalize_text(a) == normalize_text(e);
}

json run_eval(const EvalTask& task) {
    std::cout << "[eval] task=" << task.task_id
              << " binary=" << task.user_binary
              << " cpu=" << task.cpu_limit_ms << "ms"
              << " mem=" << task.mem_limit_bytes
              << " pids=" << task.max_pids << std::endl;

    std::string tmp_dir = "/tmp/eval_" + task.task_id;
    fs::create_directories(tmp_dir);
    // permissions set by create_directories (owner rwx)
    std::string stdout_path = tmp_dir + "/stdout.txt";
    std::string stderr_path = tmp_dir + "/stderr.txt";

    std::string cg_path;
    try {
        cg_path = CgroupManager::create_judge(task.task_id, task.cpu_limit_ms,
                                        task.mem_limit_bytes, task.max_pids);
    } catch (const std::exception& e) {
        cleanup_tmp(tmp_dir);
        return {{"task_id", task.task_id}, {"status", "SE"}, {"error", e.what()}};
    }

    pid_t pid = fork();
    if (pid < 0) {
        CgroupManager::destroy(cg_path);
        cleanup_tmp(tmp_dir);
        return {{"task_id", task.task_id}, {"status", "SE"}, {"error", "fork failed"}};
    }

    if (pid == 0) {
        CgroupManager::attach_pid(cg_path, getpid());
        SandboxConfig cfg;
        cfg.cpu_limit_ms    = task.cpu_limit_ms;
        cfg.mem_limit_bytes = task.mem_limit_bytes;
        cfg.max_pids        = task.max_pids;
        cfg.problem_data    = task.problem_data;
        cfg.user_binary     = task.user_binary;
        cfg.args            = task.args;
        cfg.stdin_file      = task.stdin_file;
        cfg.stdout_file     = stdout_path;
        cfg.stderr_file     = stderr_path;
        sandbox_main(cfg); // [[noreturn]]
    }

    // Wall-clock timeout: 3x CPU limit + 2s grace
    auto deadline = std::chrono::steady_clock::now()
                  + std::chrono::milliseconds(task.cpu_limit_ms * 3 + 2000);
    int wstatus = 0;
    bool wall_timeout = false;

    // wait4 取的是这一个子进程的 rusage。原先用 getrusage(RUSAGE_CHILDREN)，
    // 那是本进程所有已回收子进程的累计值，从第二个任务起就会把前面任务的
    // CPU 时间和 RSS 一并算进来，导致 CPU/MLE 误判。
    struct rusage ru{};
    bool have_ru = false;
    while (true) {
        pid_t ret = wait4(pid, &wstatus, WNOHANG, &ru);
        if (ret == pid) { have_ru = true; break; }
        if (ret < 0) break;
        if (std::chrono::steady_clock::now() >= deadline) {
            kill(pid, SIGKILL);
            if (wait4(pid, &wstatus, 0, &ru) == pid) have_ru = true;
            wall_timeout = true;
            break;
        }
        usleep(1000);
    }

    uint64_t cpu_ns = 0;
    uint64_t mem_bytes = 0;
    if (have_ru) {
        cpu_ns = (uint64_t)(ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1000000000ULL
               + (uint64_t)(ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) * 1000ULL;
        mem_bytes = (uint64_t)ru.ru_maxrss * 1024ULL;  // maxrss is in KB on Linux
    }

    // cgroup 统计更准（覆盖所有后代进程），可用时优先
    auto cg_usage = CgroupManager::read_usage(cg_path);
    uint64_t oom_kills = read_oom_kills(cg_path);
    CgroupManager::destroy(cg_path);

    if (cg_usage.cpu_ns > 0) cpu_ns = cg_usage.cpu_ns;
    if (cg_usage.mem_bytes > 0) mem_bytes = cg_usage.mem_bytes;

    std::string stderr_content;
    {
        std::ifstream f(stderr_path);
        if (f.is_open()) {
            std::ostringstream ss;
            ss << f.rdbuf();
            stderr_content = ss.str();
        }
    }

    json result;
    result["task_id"]   = task.task_id;
    result["cpu_ns"]    = cpu_ns;
    result["mem_bytes"] = mem_bytes;
    result["exit_code"] = WIFEXITED(wstatus) ? WEXITSTATUS(wstatus) : -1;

    // 1ms = 1e6 ns。原实现乘的是 1e9，相当于把限制放大 1000 倍，CPU 超时几乎不会命中。
    bool cpu_exceeded = (cpu_ns > static_cast<uint64_t>(task.cpu_limit_ms) * 1000000ULL);
    // OOM 命中时 memory.peak 可能刚好等于上限而不严格大于，单靠 mem_bytes 比不出来
    bool mem_exceeded = (mem_bytes > task.mem_limit_bytes) || (oom_kills > 0);

    if (wall_timeout || cpu_exceeded) {
        result["status"] = "TLE";
    } else if (mem_exceeded) {
        result["status"] = "MLE";
    } else if (WIFSIGNALED(wstatus)) {
        result["status"] = "RE";
        result["signal"] = WTERMSIG(wstatus);
    } else if (!WIFEXITED(wstatus) || WEXITSTATUS(wstatus) != 0) {
        if (task.checker == "exitcode") {
            // SPJ 判定器：非 0 退出 = 不通过（WA），stderr 作为错误信息
            result["status"] = "WA";
            if (!stderr_content.empty())
                result["error"] = stderr_content.substr(0, 2048);
        } else {
            result["status"] = "RE";
            if (!stderr_content.empty())
                result["stderr"] = stderr_content.substr(0, 2048);
        }
    } else {
        if (task.checker == "exitcode") {
            // SPJ 判定器：退出码 0 = 通过
            result["status"] = "AC";
        } else if (!task.expected_output_file.empty()) {
            bool ac = compare_output(stdout_path, task.expected_output_file);
            result["status"] = ac ? "AC" : "WA";
        } else {
            result["status"] = "AC";
        }
    }

    cleanup_tmp(tmp_dir);
    return result;
}

int main() {
    signal(SIGINT,  signal_handler);
    signal(SIGTERM, signal_handler);

    std::cout << "[eval-worker] ready. reading JSON tasks from stdin (one per line)..." << std::endl;
    std::cout << "[eval-worker] send Ctrl+C or EOF to stop." << std::endl;

    std::string line;
    while (g_running.load() && std::getline(std::cin, line)) {
        if (line.empty()) continue;
        try {
            auto task = parse_task(line);
            auto result = run_eval(task);
            std::cout << result.dump() << std::endl;
        } catch (const std::exception& e) {
            std::cerr << "[eval] error: " << e.what() << std::endl;
        }
    }

    std::cout << "[eval-worker] shutting down." << std::endl;
    return 0;
}
