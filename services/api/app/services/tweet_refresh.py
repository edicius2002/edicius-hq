import asyncio, os, re, sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

@dataclass
class Refresh: 
    handle:str; state:str='idle'; scroll:int=0; new:int=0; error:str|None=None; finishedAt:str|None=None
class TweetRefreshRunner:
 def __init__(self): self.pass_:Refresh|None=None; self.task:asyncio.Task|None=None
 def current(self): return self.pass_
 def start(self, handle:str):
  if self.pass_ and self.pass_.state=='running': return self.pass_
  self.pass_=Refresh(handle=handle,state='running'); self.task=asyncio.create_task(self._run()); return self.pass_
 async def _run(self):
  assert self.pass_
  root=Path(__file__).resolve().parents[4]; script=root/'tools/x-scraper/scrape.py'
  env={**os.environ,'HOME':'/home/edicius','PLAYWRIGHT_HOST_PLATFORM_OVERRIDE':'ubuntu24.04-x64'}
  proc=await asyncio.create_subprocess_exec(sys.executable,str(script),self.pass_.handle,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT,env=env)
  assert proc.stdout
  async for raw in proc.stdout:
   text=raw.decode(errors='replace'); m=re.search(r'scroll (\d+).*nuevos (\d+)',text)
   if m: self.pass_.scroll=int(m[1]); self.pass_.new=int(m[2])
   if 'No hay sesión X' in text or 'La sesión X expiró' in text: self.pass_.error='Sesión X inválida; ejecuta import_session.py.'
  code=await proc.wait(); self.pass_.state='finished' if code==0 else 'failed'; self.pass_.finishedAt=datetime.now(UTC).isoformat()
  if code and not self.pass_.error: self.pass_.error='El scraper falló; revisa perfil y Chromium local.'
RUNNER=TweetRefreshRunner()
