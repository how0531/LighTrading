const electron = require('electron')
console.log('type:', typeof electron)
console.log('keys:', Object.keys(electron || {}).slice(0, 10))
const { app } = electron
console.log('app:', app)
if (app) {
  app.whenReady().then(() => {
    console.log('Electron ready! isPackaged:', app.isPackaged)
    app.quit()
  })
}
