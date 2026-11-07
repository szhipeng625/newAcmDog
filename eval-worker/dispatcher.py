#!/usr/bin/env python3
import json,os,socket,struct,time,select,threading,shutil,subprocess
from collections import deque,OrderedDict
from concurrent.futures import ThreadPoolExecutor
import pika

SOCK_DIR='/tmp/judge_socks'
SANDBOX_COUNT=3
LRU_MAX=20
LRU_TTL=3600
DATA_ROOT='/tmp/cloud_judge_data'
CGROUP_ROOT='/sys/fs/cgroup/cloud_judge'
MQ_HOST='127.0.0.1'
MQ_IN='oj.judge'
MQ_OUT='oj.judge.result'
MAX_FRAME=64*1024*1024
RECV_CHUNK=65536

sandboxes={}
tasks_in_flight={}
idle_fds=deque()
sub_results={}
test_queue=deque()
fd_inbuf={}
fd_outbuf={}
executor=ThreadPoolExecutor(max_workers=4)
pub_queue=deque()
pub_lock=threading.Lock()
sub_lock=threading.Lock()
ep=None

class LRUCache:
    def __init__(self,m=20,ttl=3600):
        self.m=m;self.ttl=ttl;self.d=OrderedDict()
    def get(self,pid):
        if pid not in self.d: return self._load(pid)
        mt,d=self.d[pid]
        if time.time()-mt>self.ttl: del self.d[pid];return self._load(pid)
        self.d.move_to_end(pid)
        return d
    def _load(self,pid):
        p=os.path.join(DATA_ROOT,'p%s'%pid)
        if not os.path.isdir(p): return None
        tests=[]
        for f in sorted(os.listdir(p)):
            if f.endswith('.in'):
                idx=f.replace('.in','')
                of='%s.out'%idx
                if os.path.exists(os.path.join(p,of)):
                    with open(os.path.join(p,f)) as fi,open(os.path.join(p,of)) as fo:
                        tests.append({'id':idx,'input':fi.read(),'answer':fo.read()})
        d={'tests':tests,'path':p}
        if len(self.d)>=self.m: self.d.popitem(last=False)
        self.d[pid]=(time.time(),d)
        return d
lru=LRUCache(LRU_MAX,LRU_TTL)

def flush_out(fd):
    info=sandboxes.get(fd)
    if not info: return
    sock=info['sock']
    buf=fd_outbuf.get(fd,b'')
    if not buf:
        try: ep.modify(fd,select.EPOLLIN)
        except Exception: pass
        return
    try:
        n=sock.send(buf)
        if n>0: fd_outbuf[fd]=buf[n:]
    except BlockingIOError:
        pass
    except Exception:
        raise
    if fd_outbuf.get(fd,b''):
        try: ep.modify(fd,select.EPOLLIN|select.EPOLLOUT)
        except Exception: pass
    else:
        try: ep.modify(fd,select.EPOLLIN)
        except Exception: pass

def send_frame(fd,obj):
    raw=json.dumps(obj,ensure_ascii=False).encode()
    data=struct.pack('>I',len(raw))+raw
    fd_outbuf[fd]=fd_outbuf.get(fd,b'')+data
    flush_out(fd)

WORK_BASE='/tmp/judge_work'

def compile_submission(sid,code,language):
    """Compile the whole submission once. Returns (bin_path, error)."""
    lang=(language or 'cpp').lower()
    wd=os.path.join(WORK_BASE,'sub_%s'%sid)
    try:
        os.makedirs(wd,exist_ok=True)
    except Exception as e:
        return None,'workdir error: %s'%e
    try:
        if lang in ('cpp','c++','cc'):
            src=os.path.join(wd,'main.cpp'); binp=os.path.join(wd,'a.out')
            with open(src,'w') as f: f.write(code)
            p=subprocess.run(['g++','-std=c++17','-O2','-o',binp,src],capture_output=True,timeout=60)
        elif lang=='c':
            src=os.path.join(wd,'main.c'); binp=os.path.join(wd,'a.out')
            with open(src,'w') as f: f.write(code)
            p=subprocess.run(['gcc','-std=c17','-O2','-o',binp,src],capture_output=True,timeout=60)
        elif lang in ('py','python','python3'):
            binp=os.path.join(wd,'run.py')
            with open(binp,'w') as f: f.write(code)
            return binp,None
        else:
            return None,'unknown lang: %s'%lang
    except subprocess.TimeoutExpired:
        return None,'compile timeout'
    except Exception as e:
        return None,'compile error: %s'%e
    if p.returncode!=0:
        return None,(p.stderr.decode('utf-8','replace') or 'compile failed')[:4000]
    return binp,None

def spawn_sandbox(sid):
    sp=os.path.join(SOCK_DIR,'sandbox_%s.sock'%sid)
    os.makedirs(SOCK_DIR,exist_ok=True)
    if os.path.exists(sp): os.unlink(sp)
    ls=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    ls.bind(sp)
    ls.listen(1)
    ls.setblocking(False)
    pid=os.fork()
    if pid==0:
        os.closerange(3,100)
        os.environ['SANDOCK_PATH']=sp
        os.execvp('python3',['python3','/home/admin/eval-worker/judge_sandbox.py'])
    return pid,ls,sp

def restart_sandbox(ep,sid,old_sp):
    try: os.unlink(old_sp)
    except Exception: pass
    pid,ls,sp=spawn_sandbox(sid)
    ep.register(ls.fileno(),select.EPOLLIN)
    sandboxes[ls.fileno()]={'sid':sid,'type':'listen','sock':ls,'path':sp}
    print('[dispatcher] sandbox %s restarted pid=%s'%(sid,pid),flush=True)
    return pid

def _on_point_done(sub_id,result,task):
    status='AC'
    if result.get('compile_error'): status='CE'
    elif result.get('timed_out'): status='TLE'
    elif result.get('oom'): status='MLE'
    elif result.get('exit_code',0)!=0: status='RE'
    elif result.get('stdout','').strip()!=task.get('answer','').strip(): status='WA'
    pr={'point_idx':task['point_idx'],'status':status,
        'cpu_us':result.get('cpu_us',0),'wall_us':result.get('wall_us',0),
        'peak_mem':result.get('peak_mem',0)}
    with sub_lock:
        sr=sub_results.get(sub_id)
        if not sr: return
        sr['results'][task['point_idx']]=pr
        sr['finished']+=1
        if sr['finished']!=sr['total']:
            prog=sr['sub'].copy()
            prog.pop('code',None)
            prog['status']='judging'
            prog['progress']=sr['finished']
            prog['total']=sr['total']
            prog['point_idx']=task['point_idx']
            prog['point_status']=status
            with pub_lock:
                pub_queue.append(('progress',prog,None,None,None,None))
            return
        all_r=[sr['results'][i] for i in range(sr['total'])]
        verdict='AC'
        for r in all_r:
            if r['status']!='AC': verdict=r['status'];break
        out=sr['sub'].copy()
        out['status']=verdict
        out['points']=all_r
        total_cpu=sum(r['cpu_us'] for r in all_r)
        total_wall=max(r['wall_us'] for r in all_r) if all_r else 0
        out['total_cpu_us']=total_cpu
        out['total_wall_us']=total_wall
        tag=sr['tag']
        wd=sr.get('work_dir')
        del sub_results[sub_id]
    with pub_lock:
        pub_queue.append(('final',out,tag,wd,sub_id,verdict))

def _drain_publish(ch):
    while True:
        with pub_lock:
            if not pub_queue: return
            kind,out,tag,wd,sid,verdict=pub_queue.popleft()
        try:
            ch.basic_publish('',MQ_OUT,json.dumps(out,ensure_ascii=False).encode())
            if kind=='final':
                ch.basic_ack(tag)
                if wd:
                    try: shutil.rmtree(wd,ignore_errors=True)
                    except Exception: pass
                print('[dispatcher] %s -> %s'%(sid,verdict),flush=True)
            else:
                print('[dispatcher] %s progress %s/%s point=%s %s'%(
                    out.get('task_id'),out.get('progress'),out.get('total'),
                    out.get('point_idx'),out.get('point_status')),flush=True)
        except Exception as e:
            print('[dispatcher] publish error: %s'%e,flush=True)
            return

def main():
    global ep
    ep=select.epoll()
    for sid in range(SANDBOX_COUNT):
        pid,ls,sp=spawn_sandbox(sid)
        ep.register(ls.fileno(),select.EPOLLIN)
        sandboxes[ls.fileno()]={'sid':sid,'type':'listen','sock':ls,'path':sp}
    conn=pika.BlockingConnection(pika.ConnectionParameters(MQ_HOST))
    ch=conn.channel()
    ch.queue_declare(MQ_IN,durable=True)
    ch.queue_declare(MQ_OUT,durable=True)
    print('[dispatcher] started, %s sandboxes'%SANDBOX_COUNT,flush=True)
    while True:
        events=ep.poll(timeout=0.1)
        for fd,ev in events:
            info=sandboxes.get(fd)
            if not info: continue
            if info['type']=='listen':
                try:
                    client,_=info['sock'].accept()
                except BlockingIOError: continue
                client.setblocking(False)
                cfd=client.fileno()
                ep.register(cfd,select.EPOLLIN)
                sandboxes[cfd]={'sid':info.get('sid'),'type':'client','sock':client,'path':info.get('path')}
                fd_inbuf[cfd]=b''
                fd_outbuf[cfd]=b''
                idle_fds.append(cfd)
                ep.unregister(fd)
                info['sock'].close()
                del sandboxes[fd]
                print('[dispatcher] sandbox %s connected'%info.get('sid'),flush=True)
            elif info['type']=='client':
                closed=False
                if ev & select.EPOLLOUT:
                    try: flush_out(fd)
                    except Exception as e:
                        print('[dispatcher] sandbox %s flush error: %s'%(info.get('sid'),e),flush=True)
                        closed=True
                if not closed and (ev & select.EPOLLIN):
                    try:
                        data=info['sock'].recv(RECV_CHUNK)
                        if not data: raise ConnectionError('disconnected')
                        fd_inbuf[fd]=fd_inbuf.get(fd,b'')+data
                    except BlockingIOError:
                        pass
                    except Exception as e:
                        print('[dispatcher] sandbox %s error: %s'%(info.get('sid'),e),flush=True)
                        closed=True
                if not closed:
                    while True:
                        buf=fd_inbuf.get(fd,b'')
                        if len(buf)<4: break
                        length=struct.unpack('>I',buf[:4])[0]
                        if length>MAX_FRAME:
                            print('[dispatcher] sandbox %s bad frame len %s'%(info.get('sid'),length),flush=True)
                            closed=True
                            break
                        if len(buf)<4+length: break
                        frame=buf[4:4+length]
                        fd_inbuf[fd]=buf[4+length:]
                        try:
                            result=json.loads(frame.decode())
                        except Exception as e:
                            print('[dispatcher] sandbox %s decode error: %s'%(info.get('sid'),e),flush=True)
                            closed=True
                            break
                        task=tasks_in_flight.pop(fd,None)
                        if task:
                            try:
                                executor.submit(_on_point_done,task['sub_id'],result,task)
                            except Exception as e:
                                print('[dispatcher] point done error: %s'%e,flush=True)
                        if fd not in idle_fds:
                            idle_fds.append(fd)
                if closed:
                    sid=info.get('sid')
                    path=info.get('path')
                    for k,v in list(sandboxes.items()):
                        if v.get('sid')==sid:
                            try: ep.unregister(k)
                            except Exception: pass
                            try: v['sock'].close()
                            except Exception: pass
                            del sandboxes[k]
                            fd_inbuf.pop(k,None)
                            fd_outbuf.pop(k,None)
                    while fd in idle_fds:
                        idle_fds.remove(fd)
                    restart_sandbox(ep,sid,path)
                    continue
        while True:
            method,props,body=ch.basic_get(MQ_IN,auto_ack=False)
            if not method: break
            try:
                sub=json.loads(body)
            except Exception:
                ch.basic_nack(method.delivery_tag,requeue=False);continue
            pid=sub.get('problem_id',0)
            prob=lru.get(pid)
            if not prob:
                ch.basic_nack(method.delivery_tag,requeue=True)
                continue
            sid=sub.get('task_id','sub_%d'%int(time.time()*1e6))
            binp,cerr=compile_submission(sid,sub.get('code',''),sub.get('language','cpp'))
            if cerr is not None:
                pts=[{'point_idx':i,'status':'CE','cpu_us':0,'wall_us':0,'peak_mem':0}
                     for i in range(len(prob['tests']))]
                out=sub.copy()
                out['status']='CE'
                out['points']=pts
                out['compile_error']=cerr
                out['total_cpu_us']=0
                out['total_wall_us']=0
                try:
                    ch.basic_publish('',MQ_OUT,json.dumps(out,ensure_ascii=False).encode())
                    ch.basic_ack(method.delivery_tag)
                    print('[dispatcher] %s -> CE'%sid,flush=True)
                except Exception as _e:
                    print('[dispatcher] CE publish error: %s'%_e,flush=True)
                    ch.basic_nack(method.delivery_tag,requeue=True)
                try:
                    shutil.rmtree(os.path.join(WORK_BASE,'sub_%s'%sid),ignore_errors=True)
                except Exception:
                    pass
                continue
            work_dir=os.path.join(WORK_BASE,'sub_%s'%sid)
            sub_results[sid]={'total':len(prob['tests']),'finished':0,
                             'results':[None]*len(prob['tests']),
                             'sub':sub,'tag':method.delivery_tag,'work_dir':work_dir}
            for i,t in enumerate(prob['tests']):
                test_queue.append({'sub_id':sid,'point_idx':i,'answer':t['answer'],
                    'payload':{'sub_id':sid,'problem_id':pid,'point_idx':i,
                        'bin_path':binp,'language':sub.get('language','cpp'),
                        'input':t['input'],
                        'cpu_limit_ms':sub.get('cpu_limit_ms',1000),
                        'mem_limit_bytes':sub.get('mem_limit_bytes',268435456)}})
        while idle_fds and test_queue:
            fd=idle_fds.popleft()
            t=test_queue.popleft()
            info=sandboxes.get(fd)
            if not info:
                test_queue.appendleft(t)
                continue
            try:
                send_frame(fd,t['payload'])
                tasks_in_flight[fd]=t
            except Exception as e:
                print('[dispatcher] send error: %s'%e,flush=True)
                idfd=fd
                sid=info.get('sid')
                path=info.get('path')
                for k,v in list(sandboxes.items()):
                    if v.get('sid')==sid:
                        try: ep.unregister(k)
                        except Exception: pass
                        try: v['sock'].close()
                        except Exception: pass
                        del sandboxes[k]
                        fd_inbuf.pop(k,None)
                        fd_outbuf.pop(k,None)
                while idfd in idle_fds:
                    idle_fds.remove(idfd)
                restart_sandbox(ep,sid,path)
                test_queue.appendleft(t)
                break
        _drain_publish(ch)
if __name__=='__main__':
    main()
