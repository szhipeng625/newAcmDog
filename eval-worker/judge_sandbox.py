#!/usr/bin/env python3
"""judge_sandbox.py -- cgroup v2 sandbox execution unit."""
import json, os, socket, struct, subprocess, sys, time, shutil

SOCK_PATH = os.environ.get('SANDOCK_PATH', '/tmp/judge_socks/sandbox_0.sock')
CGROUP_BASE = '/sys/fs/cgroup/cloud_judge'
WORK_BASE = '/tmp/judge_work'

def recv_msg(sock):
    hdr = b''
    while len(hdr) < 4:
        chunk = sock.recv(4 - len(hdr))
        if not chunk:
            raise ConnectionError('disconnected')
        hdr += chunk
    length = struct.unpack('>I', hdr)[0]
    if length > 10 * 1024 * 1024:
        raise ValueError(f'oversized: {length}')
    payload = b''
    while len(payload) < length:
        chunk = sock.recv(length - len(payload))
        if not chunk:
            raise ConnectionError('disconnected')
        payload += chunk
    return json.loads(payload.decode('utf-8'))

def send_msg(sock, obj):
    raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    sock.sendall(struct.pack('>I', len(raw)) + raw)

def compile_code(code, language, workdir):
    os.makedirs(workdir, exist_ok=True)
    lang = (language or 'cpp').lower()
    if lang in ('cpp', 'c++', 'cc'):
        src = os.path.join(workdir, 'main.cpp')
        binp = os.path.join(workdir, 'a.out')
        with open(src, 'w') as f: f.write(code)
        proc = subprocess.run(['g++', '-std=c++17', '-O2', '-o', binp, src], capture_output=True, timeout=30)
    elif lang == 'c':
        src = os.path.join(workdir, 'main.c')
        binp = os.path.join(workdir, 'a.out')
        with open(src, 'w') as f: f.write(code)
        proc = subprocess.run(['gcc', '-std=c17', '-O2', '-o', binp, src], capture_output=True, timeout=30)
    elif lang in ('py', 'python', 'python3'):
        binp = os.path.join(workdir, 'run.py')
        with open(binp, 'w') as f: f.write(code)
        proc = subprocess.CompletedProcess(args=[], returncode=0, stdout=b'', stderr=b'')
    else:
        return {'ok': False, 'error': f'unknown lang: {lang}'}
    return {'ok': proc.returncode==0, 'error': proc.stderr.decode('utf-8', 'replace'), 'bin_path': binp}

def cgroup_run(bin_path, workdir, language, stdin_text, 
                     cpu_limit_ms, mem_limit_bytes):
    cg = os.path.join(CGROUP_BASE, f"j_{int(time.time()*1e6)}")
    os.makedirs(cg, exist_ok=True)
    try:
        for fn, val in [('memory.max', str(mem_limit_bytes)), ('memory.swap.max', '0'), ('pids.max', '64'), ('cpu.max', '100000 100000')]:
            with open(os.path.join(cg, fn), 'w') as f: f.write(val)
    except OSError as e:
        _clean(cg)
        return {'exit_code': -1, 'stdout': '', 'stderr': str(e), 'timed_out': False,
                'oom': False, 'cpu_us': 0, 'wall_us': 0, 'peak_mem': 0}
    lang = (language or 'cpp').lower()
    cmd = ['python3', bin_path] if lang in ('py', 'python', 'python3') else [bin_path]
    start = time.time()
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=workdir, preexec_fn=os.setsid)
    try:
        with open(os.path.join(cg, 'cgroup.procs'), 'w') as f: f.write(str(proc.pid))
    except OSError: pass
    timeout_sec = cpu_limit_ms / 1000.0 + 2.0
    timed_out = False
    try:
        stdout, stderr = proc.communicate(input=stdin_text.encode('utf-8', 'replace'), timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        stdout, stderr = proc.communicate()
    wall_us = int((time.time() - start) * 1e6)
    time.sleep(0.01)
    cpu_us = _ru(cg, 'cpu.stat', 'usage_usec')
    peak = _rv(cg, 'memory.peak')
    oom = _ru(cg, 'memory.events', 'oom_kill')
    _clean(cg)
    _rc = proc.returncode if proc.returncode is not None else -1
    return {'exit_code': _rc, 'stdout': stdout.decode('utf-8', 'replace'),
            'stderr': stderr.decode('utf-8', 'replace'), 'timed_out': timed_out,
            'oom': oom > 0, 'cpu_us': cpu_us, 'wall_us': wall_us, 'peak_mem': peak}

def _ru(cg, fn, key):
    try:
        with open(os.path.join(cg, fn)) as f:
            for l in f:
                if l.startswith(key + ' '): return int(l.split()[1])
    except: pass
    return 0

def _rv(cg, fn):
    try:
        with open(os.path.join(cg, fn)) as f:
            return int(f.read().strip())
    except: return 0

def _clean(cg):
    try:
        open(os.path.join(cg, 'cgroup.kill'), 'w').write('1')
    except: pass
    time.sleep(0.01)
    try: os.rmdir(cg)
    except: pass

def main():
    sock = None
    for i in range(30):
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(SOCK_PATH)
            break
        except (FileNotFoundError, ConnectionRefusedError):
            sock.close()
            time.sleep(0.5)
    else:
        print(f'[sandbox] cannot connect {SOCK_PATH}', file=sys.stderr)
        sys.exit(1)
    print(f'[sandbox] connected {SOCK_PATH}', file=sys.stderr, flush=True)
    while True:
        try:
            task = recv_msg(sock)
        except Exception as e:
            print(f'[sandbox] recv error: {e}', file=sys.stderr, flush=True)
            break
        sub_id = task.get('sub_id', 'unknown')
        pi = task.get('point_idx', 0)
        wd = os.path.join(WORK_BASE, f"{sub_id}_{pi}")
        try:
            os.makedirs(wd, exist_ok=True)
        except Exception:
            pass
        binp = task.get('bin_path')
        if not binp:
            cr = compile_code(task.get('code', ''), task.get('language', 'cpp'), wd)
            if not cr['ok']:
                send_msg(sock, {'point_idx': pi, 'status': 'CE', 'compile_error': cr['error'], 'cpu_us': 0, 'wall_us': 0, 'peak_mem': 0})
                continue
            binp = cr['bin_path']
        rr = cgroup_run(binp, wd, task.get('language', 'cpp'), 
                        task.get('input', ''), 
                        task.get('cpu_limit_ms', 1000), 
                        task.get('mem_limit_bytes', 268435456))
        send_msg(sock, {'point_idx': pi, 'exit_code': rr['exit_code'],
                        'stdout': rr['stdout'], 'stderr': rr['stderr'],
                        'timed_out': rr['timed_out'], 'oom': rr['oom'], 
                        'cpu_us': rr['cpu_us'], 'wall_us': rr['wall_us'], 
                        'peak_mem': rr['peak_mem']})
        try: shutil.rmtree(wd, ignore_errors=True)
        except: pass

if __name__ == '__main__':
    main()