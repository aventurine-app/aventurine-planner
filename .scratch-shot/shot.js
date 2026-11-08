const fs=require('fs'),os=require('os'),path=require('path');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../scripts/dev-server');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(),'shot-')));
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async()=>{
  const server = createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const win = new BrowserWindow({show:false,width:1200,height:500,webPreferences:{offscreen:true}});
  for (const [u,f] of [['/','full'],['/demo','demo']]) {
    await win.loadURL(`http://127.0.0.1:${server.address().port}${u}`);
    await new Promise(r=>setTimeout(r,2500));
    const img = await win.webContents.capturePage({x:0,y:0,width:600,height:60});
    fs.writeFileSync(path.join(__dirname,f+'.png'), img.toPNG());
  }
  app.quit();
});
