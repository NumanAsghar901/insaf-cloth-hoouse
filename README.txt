BUILD THE INSTALLER (on your Windows PC, needs internet the first time)
1. Open a terminal in this folder.
2. npm install        (downloads Electron, takes a few minutes)
3. npm run dist       (creates installer in the "dist" folder: "Garments POS Setup 2.0.0.exe")
To just test without building: npm start

LOGIN
First login: admin / admin123  -> change it immediately in the Users tab.
Admin creates cashier accounts in the Users tab.

OTHER PCs: on the PC running the app, other PCs open http://<that-PC-IP>:3000 in a browser.
Allow it through Windows Firewall when asked. Data: C:\Users\<you>\AppData\Roaming\Garments POS\shop.db (back this up).
