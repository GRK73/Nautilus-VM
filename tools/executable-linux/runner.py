#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, shutil, subprocess, time
from pathlib import Path

parser=argparse.ArgumentParser(); parser.add_argument('--input',required=True); parser.add_argument('--output',required=True); parser.add_argument('--timeout',type=int,default=15); args=parser.parse_args()
started=time.time(); output=Path(args.output); output.mkdir(parents=True,exist_ok=True); work=Path('/tmp/work'); work.mkdir(parents=True,exist_ok=True)
program=work/'program'; shutil.copy2(args.input,program); program.chmod(0o500); before={p.name for p in work.iterdir()}; log='strace.log'; status='completed'; code=None; error=None
try:
    result=subprocess.run(['strace','-ff','-o',str(output/'trace'),str(program)],cwd=work,capture_output=True,text=True,timeout=args.timeout,env={'HOME':'/tmp','PATH':'/usr/bin:/bin'})
    code=result.returncode; (output/log).write_text(result.stdout+'\n--- stderr ---\n'+result.stderr,encoding='utf-8',errors='replace')
except subprocess.TimeoutExpired as exc:
    status='timeout'; (output/log).write_text((exc.stdout or '')+'\n'+(exc.stderr or ''),encoding='utf-8',errors='replace')
except Exception as exc:
    status='error'; error=str(exc); (output/log).write_text(str(exc),encoding='utf-8')
produced=[]
for path in work.iterdir():
    if path.name not in before and path.is_file():
        name=f'produced-{len(produced):03d}-{path.name}'; shutil.copy2(path,output/name); produced.append(name)
trace_files=sorted(output.glob('trace*'))
if trace_files:
    with (output/log).open('a',encoding='utf-8') as handle:
        for trace in trace_files: handle.write(f'\n--- {trace.name} ---\n'+trace.read_text(errors='replace'))
print(json.dumps({'status':status,'worker':'gvisor','exitCode':code,'durationSec':round(time.time()-started,3),'screenshots':[],'logFile':log,'producedFiles':produced,**({'error':error} if error else {})},separators=(',',':')))
