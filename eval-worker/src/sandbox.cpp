#include "sandbox.h"
#include "cgroup_manager.h"
#include <seccomp.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <grp.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>
#include <csignal>
#include <vector>

// 安装 seccomp BPF 白名单过滤器
static int install_seccomp() {
    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_KILL_PROCESS);
    if (!ctx) return -1;

    // 运行时必需的系统调用白名单
    // 覆盖 glibc / libstdc++ / Go / JVM / CPython 运行时
    int allowed[] = {
        // I/O
        SCMP_SYS(read), SCMP_SYS(write), SCMP_SYS(lseek),
        SCMP_SYS(openat), SCMP_SYS(close), SCMP_SYS(fcntl),
        SCMP_SYS(fstat), SCMP_SYS(newfstatat), SCMP_SYS(stat), SCMP_SYS(lstat),
        SCMP_SYS(access), SCMP_SYS(faccessat), SCMP_SYS(faccessat2),
        SCMP_SYS(getcwd), SCMP_SYS(readlink), SCMP_SYS(readlinkat),
        SCMP_SYS(ioctl), SCMP_SYS(dup), SCMP_SYS(dup2), SCMP_SYS(dup3),
        SCMP_SYS(pipe), SCMP_SYS(pipe2),
        SCMP_SYS(select), SCMP_SYS(pselect6), SCMP_SYS(poll), SCMP_SYS(ppoll),
        SCMP_SYS(epoll_create), SCMP_SYS(epoll_create1), SCMP_SYS(epoll_ctl),
        SCMP_SYS(epoll_wait), SCMP_SYS(epoll_pwait),

        // Memory
        SCMP_SYS(mmap), SCMP_SYS(munmap), SCMP_SYS(mprotect), SCMP_SYS(mremap),
        SCMP_SYS(brk), SCMP_SYS(madvise), SCMP_SYS(mincore), SCMP_SYS(msync),

        // Process / Thread
        SCMP_SYS(clone), SCMP_SYS(clone3), SCMP_SYS(execve),
        SCMP_SYS(wait4), SCMP_SYS(waitid),
        SCMP_SYS(exit), SCMP_SYS(exit_group),
        SCMP_SYS(kill), SCMP_SYS(tkill), SCMP_SYS(tgkill),
        SCMP_SYS(getpid), SCMP_SYS(getppid), SCMP_SYS(gettid), SCMP_SYS(getpgrp),
        SCMP_SYS(getuid), SCMP_SYS(getgid), SCMP_SYS(geteuid), SCMP_SYS(getegid),
        SCMP_SYS(getresuid), SCMP_SYS(getresgid), SCMP_SYS(getgroups),
        SCMP_SYS(set_tid_address), SCMP_SYS(set_robust_list),
        SCMP_SYS(rseq), SCMP_SYS(prlimit64),
        SCMP_SYS(futex), SCMP_SYS(nanosleep), SCMP_SYS(clock_nanosleep),
        SCMP_SYS(clock_gettime), SCMP_SYS(clock_getres),
        SCMP_SYS(gettimeofday), SCMP_SYS(times),
        SCMP_SYS(prctl), SCMP_SYS(alarm), SCMP_SYS(setitimer), SCMP_SYS(getitimer),
        SCMP_SYS(sched_yield), SCMP_SYS(sched_getaffinity), SCMP_SYS(sched_setaffinity),
        SCMP_SYS(sched_getparam), SCMP_SYS(sched_getscheduler),
        SCMP_SYS(sched_get_priority_min), SCMP_SYS(sched_get_priority_max),
        SCMP_SYS(getcpu), SCMP_SYS(membarrier), SCMP_SYS(getrusage),

        // Signal
        SCMP_SYS(rt_sigaction), SCMP_SYS(rt_sigprocmask),
        SCMP_SYS(rt_sigreturn), SCMP_SYS(rt_sigtimedwait),
        SCMP_SYS(rt_sigpending), SCMP_SYS(rt_sigsuspend), SCMP_SYS(rt_sigqueueinfo),
        SCMP_SYS(sigaltstack),

        // Filesystem（JVM hsperfdata / CPython __pycache__ 等）
        SCMP_SYS(umask), SCMP_SYS(mkdir), SCMP_SYS(mkdirat),
        SCMP_SYS(unlink), SCMP_SYS(unlinkat), SCMP_SYS(rmdir),
        SCMP_SYS(rename), SCMP_SYS(renameat), SCMP_SYS(renameat2),
        SCMP_SYS(chmod), SCMP_SYS(fchmod), SCMP_SYS(fchmodat), SCMP_SYS(fchdir),
        SCMP_SYS(chown), SCMP_SYS(fchown), SCMP_SYS(fchownat), SCMP_SYS(lchown),
        SCMP_SYS(utimensat), SCMP_SYS(truncate), SCMP_SYS(sendfile),
        SCMP_SYS(capget), SCMP_SYS(statx),

        // Misc required by glibc / dynamic linker
        SCMP_SYS(arch_prctl),
        SCMP_SYS(getrandom),
        SCMP_SYS(uname),
        SCMP_SYS(sysinfo),
        SCMP_SYS(getdents64),
        SCMP_SYS(writev), SCMP_SYS(readv),
        SCMP_SYS(pread64), SCMP_SYS(pwrite64),
        SCMP_SYS(fallocate),
        SCMP_SYS(ftruncate),
        SCMP_SYS(fsync), SCMP_SYS(fdatasync),
        SCMP_SYS(getrlimit),

        // JVM / CPython 额外依赖。用 __SNR_ 宏做存在性判断：老版本 libseccomp
        // 不认识较新的系统调用时宏不存在，跳过而不是编译失败。
#ifdef __SNR_eventfd2
        SCMP_SYS(eventfd2),
#endif
#ifdef __SNR_memfd_create
        SCMP_SYS(memfd_create),
#endif
#ifdef __SNR_setpriority
        SCMP_SYS(setpriority),
#endif
#ifdef __SNR_getpriority
        SCMP_SYS(getpriority),
#endif
#ifdef __SNR_sched_setscheduler
        SCMP_SYS(sched_setscheduler),
#endif
#ifdef __SNR_sched_setparam
        SCMP_SYS(sched_setparam),
#endif
#ifdef __SNR_sched_rr_get_interval
        SCMP_SYS(sched_rr_get_interval),
#endif
#ifdef __SNR_timerfd_create
        SCMP_SYS(timerfd_create), SCMP_SYS(timerfd_settime), SCMP_SYS(timerfd_gettime),
#endif
#ifdef __SNR_futex_waitv
        SCMP_SYS(futex_waitv),
#endif
    };

    for (int sys : allowed) {
        if (seccomp_rule_add(ctx, SCMP_ACT_ALLOW, sys, 0) != 0) {
            fprintf(stderr, "[sandbox] seccomp: failed to allow syscall %d\n", sys);
            seccomp_release(ctx);
            return -1;
        }
    }

    int rc = seccomp_load(ctx);
    seccomp_release(ctx);
    return rc;
}

// 沙箱内的最小环境：只保留解释器/运行时真正需要的变量。
// 宿主上的 token、代理、CI 变量一律不透传；语言运行时都通过绝对路径
// 直接 exec，不依赖 PATH 查找。
static const char* kSandboxEnv[] = {
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "HOME=/tmp",
    "TMPDIR=/tmp",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    "PYTHONIOENCODING=utf-8",
    "PYTHONDONTWRITEBYTECODE=1",   // 与 python -B 双保险，nobody 写不进 __pycache__
    nullptr,
};

// 新 PID namespace 中的用户进程（namespace 内首个进程）
[[noreturn]] static void grandchild_main(const SandboxConfig& config) {
    // 挂载本 namespace 专属 /proc（Go / JVM / CPython 运行时必需）
    if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) {
        perror("[sandbox] mount /proc");
        // 非致命：C/C++ 不依赖；缺 /proc 时 Go/JVM 会自行报错
    }
    // 彻底降权：先清 supplementary groups，再 setgid/setuid（顺序不能反）
    if (setgroups(0, nullptr) != 0) {
        perror("[sandbox] setgroups");
        _exit(126);
    }
    if (setgid(65534) != 0 || setuid(65534) != 0) {
        perror("[sandbox] drop privileges");
        _exit(126);
    }
    // setuid 会让内核清除 PR_SET_PDEATHSIG，所以必须放在降权之后；
    // 否则命名空间守护进程先死时子进程会变成孤儿，继续占着 cgroup 和 PID 配额。
    prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
    // 设置与检查之间父进程可能刚好退出，补一次判断消除竞态
    if (getppid() == 1) {
        _exit(126);
    }
    // CPU 时间兜底（秒级粒度；精确判定由上层读 cgroup cpu.stat 完成）
    if (config.cpu_limit_ms > 0) {
        struct rlimit rl;
        rl.rlim_cur = rl.rlim_max = (config.cpu_limit_ms + 999) / 1000 + 1;
        setrlimit(RLIMIT_CPU, &rl);
    }
    // 输出炸弹防御：单个文件写入超过 256MB 触发 SIGXFSZ
    {
        struct rlimit rf;
        rf.rlim_cur = rf.rlim_max = 256ULL * 1024 * 1024;
        setrlimit(RLIMIT_FSIZE, &rf);
    }
    // seccomp 过滤器（不可逆，必须在 exec 前最后一步）
    if (install_seccomp() != 0) {
        fprintf(stderr, "[sandbox] seccomp load failed\n");
        _exit(126);
    }
    // 构建 argv 并 exec 用户程序
    std::vector<const char*> argv;
    argv.push_back(config.user_binary.c_str());
    for (const auto& a : config.args) {
        argv.push_back(a.c_str());
    }
    argv.push_back(nullptr);

    std::vector<char*> envp;
    for (const char* e : kSandboxEnv) {
        if (e) envp.push_back(const_cast<char*>(e));
    }

    execve(config.user_binary.c_str(),
           const_cast<char* const*>(argv.data()),
           envp.data());
    // exec 失败才会到这里
    int exec_err = errno;
    fprintf(stderr, "[sandbox] execve(%s) failed: %s%s\n",
            config.user_binary.c_str(), strerror(exec_err),
            exec_err == ENOEXEC ? " (脚本解释器缺失或 shebang 不可执行?)" : "");
    _exit(127);
}

[[noreturn]] void sandbox_main(const SandboxConfig& config) {
    // 1. 切换到题目数据目录
    if (!config.problem_data.empty()) {
        if (chdir(config.problem_data.c_str()) != 0) {
            perror("[sandbox] chdir to problem_data");
            _exit(126);
        }
    }

    // 2. 重定向 stdin/stdout/stderr（以 admin 身份打开后传 fd，在降权之前完成）
    if (!config.stdin_file.empty()) {
        int fd = open(config.stdin_file.c_str(), O_RDONLY);
        if (fd < 0) { perror("[sandbox] open stdin_file"); _exit(126); }
        dup2(fd, STDIN_FILENO);
        close(fd);
    }
    if (!config.stdout_file.empty()) {
        int fd = open(config.stdout_file.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd < 0) { perror("[sandbox] open stdout_file"); _exit(126); }
        dup2(fd, STDOUT_FILENO);
        close(fd);
    }
    if (!config.stderr_file.empty()) {
        int fd = open(config.stderr_file.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd < 0) { perror("[sandbox] open stderr_file"); _exit(126); }
        dup2(fd, STDERR_FILENO);
        close(fd);
    }

    // 3. ===== namespace 环境隔离 =====
    // Mount + PID + Network + UTS + IPC 五重隔离；需要 CAP_SYS_ADMIN
    // （cloud_judge.service 已通过 AmbientCapabilities=CAP_SYS_ADMIN 授权）
    if (unshare(CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWUTS | CLONE_NEWIPC) != 0) {
        perror("[sandbox] unshare namespaces");
        _exit(126);
    }
    // 阻断挂载传播，防止后续 /proc 重挂载泄漏到宿主
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) {
        perror("[sandbox] remount / private");
        _exit(126);
    }

    // 4. 在新 PID namespace 中 fork 用户进程
    pid_t user_pid = fork();
    if (user_pid < 0) {
        perror("[sandbox] fork user process");
        _exit(126);
    }
    if (user_pid == 0) {
        grandchild_main(config); // [[noreturn]]
    }

    // 5. 等待用户进程退出并传递退出状态（保持上层 RE/TLE 判定语义）
    int st = 0;
    while (waitpid(user_pid, &st, 0) < 0) {
        if (errno != EINTR) _exit(126);
    }
    if (WIFSIGNALED(st)) {
        // 以相同信号自尽，让上层 run_eval 的 WIFSIGNALED 判定保持 RE 语义
        int sig = WTERMSIG(st);
        signal(sig, SIG_DFL);
        raise(sig);
        _exit(128 + sig);
    }
    _exit(WIFEXITED(st) ? WEXITSTATUS(st) : 126);
}
