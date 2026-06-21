#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, shutil, subprocess, time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--input', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--timeout', type=int, default=15)
args = parser.parse_args()
started = time.time()
output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
drive = Path('/tmp/drive'); drive.mkdir(parents=True, exist_ok=True)
data = Path(args.input).read_bytes()
if data.startswith(b'MZ'):
    filename = 'PROGRAM.EXE'
elif data.lstrip().lower().startswith((b'@echo', b'echo ')):
    filename = 'PROGRAM.BAT'
else:
    filename = 'PROGRAM.COM'
(drive / filename).write_bytes(data)
before = {p.name for p in drive.iterdir()}
log_file = 'dosbox.log'; screenshot = 'dosbox.png'
xvfb = subprocess.Popen(['Xvfb', ':99', '-screen', '0', '1024x768x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
status = 'completed'; error = None; exit_code = None
try:
    env = {**os.environ, 'DISPLAY': ':99', 'SDL_AUDIODRIVER': 'dummy'}
    launch = f'call {filename}' if filename.endswith('.BAT') else filename
    process = subprocess.Popen(['dosbox', '-exit', '-c', f'mount c {drive}', '-c', 'c:', '-c', launch, '-c', 'exit'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    time.sleep(min(1.5, args.timeout / 2))
    subprocess.run(['import', '-display', ':99', '-window', 'root', str(output / screenshot)], timeout=5, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        stdout, _ = process.communicate(timeout=args.timeout)
        exit_code = process.returncode
    except subprocess.TimeoutExpired:
        process.kill(); stdout, _ = process.communicate(); status = 'timeout'
    (output / log_file).write_text(stdout, encoding='utf-8', errors='replace')
except Exception as exc:
    status = 'error'; error = str(exc); (output / log_file).write_text(str(exc), encoding='utf-8')
finally:
    xvfb.terminate()
produced = []
for path in drive.iterdir():
    if path.name not in before and path.is_file():
        target = f'produced-{len(produced):03d}-{path.name}'
        shutil.copy2(path, output / target); produced.append(target)
screens = [screenshot] if (output / screenshot).exists() else []
print(json.dumps({'status': status, 'worker': 'dosbox', 'exitCode': exit_code, 'durationSec': round(time.time()-started,3), 'screenshots': screens, 'logFile': log_file, 'producedFiles': produced, **({'error': error} if error else {})}, separators=(',',':')))
