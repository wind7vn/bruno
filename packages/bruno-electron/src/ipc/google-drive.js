const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const archiver = require('archiver');
const { ipcMain, shell } = require('electron');
const Store = require('electron-store');

const DEFAULT_CLIENT_ID = process.env.GDRIVE_CLIENT_ID || '';
const DEFAULT_CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET || '';
const OAUTH_PORT = 52483;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/callback`;

const store = new Store({ name: 'google-drive-auth' });

let authServer = null;

const getValidAccessToken = async () => {
  const refreshToken = store.get('refreshToken');
  const clientId = store.get('clientId', DEFAULT_CLIENT_ID);
  const clientSecret = store.get('clientSecret', DEFAULT_CLIENT_SECRET);
  let accessToken = store.get('accessToken');
  const expiresAt = store.get('expiresAt', 0);

  if (!refreshToken) {
    throw new Error('Chưa đăng nhập Google Drive. Vui lòng đăng nhập trước khi đồng bộ.');
  }

  // Check if token is still valid (with 60s buffer)
  if (accessToken && Date.now() < expiresAt - 60000) {
    return accessToken;
  }

  // Refresh token
  try {
    const response = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    accessToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 3600;
    store.set('accessToken', accessToken);
    store.set('expiresAt', Date.now() + expiresIn * 1000);
    return accessToken;
  } catch (error) {
    console.error('Error refreshing Google Drive token:', error?.response?.data || error.message);
    throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng đăng nhập lại.');
  }
};

const findOrCreateFolder = async (accessToken, folderName, parentId = null) => {
  let query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) {
    query += ` and '${parentId}' in parents`;
  }

  const searchRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
    params: { q: query, fields: 'files(id, name, webViewLink)' },
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (searchRes.data.files && searchRes.data.files.length > 0) {
    return searchRes.data.files[0];
  }

  // Create folder
  const metadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (parentId) {
    metadata.parents = [parentId];
  }

  const createRes = await axios.post('https://www.googleapis.com/drive/v3/files', metadata, {
    params: { fields: 'id, name, webViewLink' },
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  return createRes.data;
};

const zipDirectory = (sourceDir, outPath) => {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(outPath));
    archive.on('error', (err) => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
};

const uploadFileMultipart = async (accessToken, filePath, fileName, parentFolderId) => {
  const boundary = '-------BrunoDriveMultipartBoundary' + Date.now();
  const fileBuffer = fs.readFileSync(filePath);

  // Check if file already exists in folder
  const checkRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
    params: {
      q: `name='${fileName}' and '${parentFolderId}' in parents and trashed=false`,
      fields: 'files(id, name, webViewLink)'
    },
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const existingFile = checkRes.data.files && checkRes.data.files[0];

  const metadata = {
    name: fileName
  };
  if (!existingFile) {
    metadata.parents = [parentFolderId];
  }

  const metadataPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      '\r\n'
  );

  const mediaPartHeader = Buffer.from(
    `--${boundary}\r\nContent-Type: application/zip\r\n\r\n`
  );

  const closingPart = Buffer.from(`\r\n--${boundary}--\r\n`);

  const multipartBody = Buffer.concat([metadataPart, mediaPartHeader, fileBuffer, closingPart]);

  const endpoint = existingFile
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=multipart&fields=id,name,webViewLink`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';

  const method = existingFile ? 'patch' : 'post';

  const uploadRes = await axios({
    method,
    url: endpoint,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': multipartBody.length
    },
    data: multipartBody
  });

  return uploadRes.data;
};

const registerGoogleDriveIpc = (mainWindow) => {
  // Get current status
  ipcMain.handle('gdrive:get-status', async () => {
    try {
      const refreshToken = store.get('refreshToken');
      const user = store.get('user');
      const lastSynced = store.get('lastSynced');
      const folderUrl = store.get('folderUrl');
      const clientId = store.get('clientId', DEFAULT_CLIENT_ID);
      const clientSecret = store.get('clientSecret', DEFAULT_CLIENT_SECRET);

      return {
        isConnected: !!refreshToken,
        user: user || null,
        lastSynced: lastSynced || null,
        folderUrl: folderUrl || null,
        clientId,
        clientSecret
      };
    } catch (error) {
      console.error('gdrive:get-status error:', error);
      return { isConnected: false, error: error.message };
    }
  });

  // Save custom OAuth config
  ipcMain.handle('gdrive:save-config', async (event, { clientId, clientSecret }) => {
    store.set('clientId', clientId || DEFAULT_CLIENT_ID);
    store.set('clientSecret', clientSecret || DEFAULT_CLIENT_SECRET);
    return { success: true };
  });

  // Start OAuth Login
  ipcMain.handle('gdrive:login', async () => {
    return new Promise((resolve, reject) => {
      const clientId = store.get('clientId', DEFAULT_CLIENT_ID);
      const clientSecret = store.get('clientSecret', DEFAULT_CLIENT_SECRET);

      if (authServer) {
        try {
          authServer.close();
        } catch (e) {}
      }

      authServer = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true);
        if (parsedUrl.pathname === '/callback') {
          const code = parsedUrl.query.code;
          const error = parsedUrl.query.error;

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h3>❌ Đăng nhập thất bại: ${error}</h3><p>Bạn có thể đóng tab này.</p>`);
            if (authServer) authServer.close();
            return reject(new Error(`Google authorization error: ${error}`));
          }

          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="utf-8">
                <title>Bruno - Google Drive Connected</title>
                <style>
                  body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
                  .box { background: #1e293b; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); max-width: 400px; }
                  h2 { color: #22c55e; margin: 0 0 12px; }
                  p { color: #94a3b8; line-height: 1.5; margin: 0; }
                </style>
              </head>
              <body>
                <div class="box">
                  <h2>✅ Đăng nhập thành công!</h2>
                  <p>Bruno đã kết nối với tài khoản Google Drive của bạn. Bạn có thể đóng tab này và quay lại ứng dụng Bruno.</p>
                </div>
              </body>
              </html>
            `);

            try {
              // Exchange code for tokens
              const tokenRes = await axios.post(
                'https://oauth2.googleapis.com/token',
                new URLSearchParams({
                  client_id: clientId,
                  client_secret: clientSecret,
                  code,
                  redirect_uri: REDIRECT_URI,
                  grant_type: 'authorization_code'
                }).toString(),
                {
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
              );

              const { access_token, refresh_token, expires_in } = tokenRes.data;
              store.set('accessToken', access_token);
              if (refresh_token) {
                store.set('refreshToken', refresh_token);
              }
              store.set('expiresAt', Date.now() + (expires_in || 3600) * 1000);

              // Fetch User profile
              const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${access_token}` }
              });

              const user = {
                email: userRes.data.email,
                name: userRes.data.name,
                picture: userRes.data.picture
              };
              store.set('user', user);

              if (authServer) authServer.close();
              resolve({ success: true, user });
            } catch (err) {
              console.error('Token exchange error:', err?.response?.data || err.message);
              if (authServer) authServer.close();
              reject(new Error(err?.response?.data?.error_description || err.message));
            }
          }
        }
      });

      authServer.listen(OAUTH_PORT, () => {
        const scopes = [
          'openid',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
          'https://www.googleapis.com/auth/drive.file'
        ].join(' ');

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(
          clientId
        )}&redirect_uri=${encodeURIComponent(
          REDIRECT_URI
        )}&response_type=code&scope=${encodeURIComponent(
          scopes
        )}&access_type=offline&prompt=consent`;

        shell.openExternal(authUrl);
      });

      authServer.on('error', (err) => {
        console.error('OAuth local server error:', err);
        reject(new Error(`Không thể khởi động cổng xác thực ${OAUTH_PORT}: ${err.message}`));
      });
    });
  });

  // Logout
  ipcMain.handle('gdrive:logout', async () => {
    store.delete('accessToken');
    store.delete('refreshToken');
    store.delete('expiresAt');
    store.delete('user');
    store.delete('lastSynced');
    store.delete('folderUrl');
    return { success: true };
  });

  // Sync current workspace to Google Drive
  ipcMain.handle('gdrive:sync', async (event, { workspacePath, workspaceName }) => {
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      throw new Error(`Đường dẫn thư mục Workspace không hợp lệ hoặc không tồn tại: ${workspacePath}`);
    }

    const accessToken = await getValidAccessToken();
    const folderName = 'Bruno Collections';

    // 1. Get or create parent folder
    const mainFolder = await findOrCreateFolder(accessToken, folderName);
    store.set('folderUrl', mainFolder.webViewLink);

    // 2. Package workspace into temp zip
    const sanitizedName = (workspaceName || 'workspace').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
    const tempZipPath = path.join(os.tmpdir(), `bruno-${sanitizedName}-${Date.now()}.zip`);

    try {
      await zipDirectory(workspacePath, tempZipPath);

      // 3. Upload zip to Google Drive
      const uploadedFile = await uploadFileMultipart(
        accessToken,
        tempZipPath,
        `${sanitizedName}.zip`,
        mainFolder.id
      );

      const lastSynced = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      store.set('lastSynced', lastSynced);

      return {
        success: true,
        lastSynced,
        folderUrl: mainFolder.webViewLink,
        fileUrl: uploadedFile.webViewLink,
        fileName: `${sanitizedName}.zip`
      };
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempZipPath)) {
        try {
          fs.unlinkSync(tempZipPath);
        } catch (e) {}
      }
    }
  });
};

module.exports = registerGoogleDriveIpc;
