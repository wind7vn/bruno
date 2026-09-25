const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const { ipcMain, shell } = require('electron');
const Store = require('electron-store');

const DEFAULT_CLIENT_ID = process.env.GDRIVE_CLIENT_ID || '';
const DEFAULT_CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET || '';
const OAUTH_PORT = 52483;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/callback`;

const store = new Store({ name: 'google-drive-auth' });

let authServer = null;

const formatApiError = (err) => {
  console.error('Google Drive API Error:', err?.response?.data || err.message);
  const apiMessage = err.response?.data?.error?.message;
  if (apiMessage) {
    if (apiMessage.includes('insufficient authentication scopes') || err.response?.status === 403) {
      return new Error(
        `Google Drive (403): ${apiMessage}.\n`
        + 'Cách khắc phục: Hãy BẬT "Google Drive API" trên Google Cloud Console, sau đó Đăng xuất và Đăng nhập lại trong Bruno, nhớ TÍCH CHỌN ô cấp quyền truy cập Google Drive.'
      );
    }
    return new Error(`Google Drive: ${apiMessage}`);
  }
  return err;
};

// Calculate SHA-256 hash of a file
const calculateFileHash = (filePath) => {
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex');
};

// Scan directory recursively and build local hash map
const buildLocalHashMap = (dirPath) => {
  const files = {};
  const walk = (currentDir) => {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(dirPath, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (['.git', 'node_modules', '.bruno', '.next', 'out'].includes(entry.name)) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') {
          continue;
        }
        try {
          const stat = fs.statSync(fullPath);
          const hash = calculateFileHash(fullPath);
          files[relPath] = {
            hash,
            size: stat.size,
            mtime: Math.floor(stat.mtimeMs)
          };
        } catch (e) {
          console.error('Error hashing file:', fullPath, e);
        }
      }
    }
  };

  walk(dirPath);
  return files;
};

// Token management with auto-refresh
const getValidAccessToken = async () => {
  const refreshToken = store.get('refreshToken');
  const clientId = store.get('clientId', DEFAULT_CLIENT_ID);
  const clientSecret = store.get('clientSecret', DEFAULT_CLIENT_SECRET);
  let accessToken = store.get('accessToken');
  const expiresAt = store.get('expiresAt', 0);

  if (!refreshToken) {
    throw new Error('Chưa đăng nhập Google Drive. Vui lòng kết nối tài khoản trước.');
  }

  if (accessToken && Date.now() < expiresAt - 60000) {
    return accessToken;
  }

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

// Find or create a folder on Google Drive
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
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  return createRes.data;
};

// Resolve parent folder ID on Drive for a relative file path (cached)
const resolveDriveFolderPath = async (accessToken, rootWorkspaceFolderId, relFilePath, folderCache) => {
  const dirName = path.dirname(relFilePath);
  if (dirName === '.' || dirName === '') {
    return rootWorkspaceFolderId;
  }

  if (folderCache[dirName]) {
    return folderCache[dirName];
  }

  const parts = dirName.split(path.sep).filter(Boolean);
  let currentParentId = rootWorkspaceFolderId;
  let accumulatedPath = '';

  for (const part of parts) {
    accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
    if (folderCache[accumulatedPath]) {
      currentParentId = folderCache[accumulatedPath];
    } else {
      const folder = await findOrCreateFolder(accessToken, part, currentParentId);
      currentParentId = folder.id;
      folderCache[accumulatedPath] = currentParentId;
    }
  }

  return currentParentId;
};

// Fetch or create manifest.json on Google Drive
const fetchRemoteManifest = async (accessToken, workspaceFolderId) => {
  const checkRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
    params: {
      q: `name='manifest.json' and '${workspaceFolderId}' in parents and trashed=false`,
      fields: 'files(id, name, webViewLink)'
    },
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!checkRes.data.files || checkRes.data.files.length === 0) {
    return { manifestFileId: null, manifest: { version: 1, files: {} } };
  }

  const manifestFile = checkRes.data.files[0];
  try {
    const contentRes = await axios.get(
      `https://www.googleapis.com/drive/v3/files/${manifestFile.id}?alt=media`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );
    return {
      manifestFileId: manifestFile.id,
      manifest: contentRes.data || { version: 1, files: {} }
    };
  } catch (err) {
    console.error('Error reading remote manifest.json:', err);
    return { manifestFileId: manifestFile.id, manifest: { version: 1, files: {} } };
  }
};

// Upload or update manifest.json on Google Drive
const saveRemoteManifest = async (accessToken, workspaceFolderId, manifestFileId, manifestData) => {
  const content = JSON.stringify(manifestData, null, 2);
  const buffer = Buffer.from(content, 'utf8');

  if (manifestFileId) {
    await axios({
      method: 'patch',
      url: `https://www.googleapis.com/upload/drive/v3/files/${manifestFileId}?uploadType=media`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': buffer.length
      },
      data: buffer
    });
    return manifestFileId;
  } else {
    // Create new
    const boundary = '-------ManifestBoundary' + Date.now();
    const metadataPart = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
      + JSON.stringify({ name: 'manifest.json', parents: [workspaceFolderId] })
      + '\r\n'
    );
    const mediaPart = Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`);
    const closingPart = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([metadataPart, mediaPart, buffer, closingPart]);

    const res = await axios({
      method: 'post',
      url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length
      },
      data: body
    });
    return res.data.id;
  }
};

// Upload single file (PATCH if existing, POST multipart if new)
const uploadSingleFile = async (accessToken, fullLocalPath, fileName, parentFolderId, existingDriveId) => {
  const fileBuffer = fs.readFileSync(fullLocalPath);

  if (existingDriveId) {
    try {
      const res = await axios({
        method: 'patch',
        url: `https://www.googleapis.com/upload/drive/v3/files/${existingDriveId}?uploadType=media&fields=id,name,webViewLink`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileBuffer.length
        },
        data: fileBuffer
      });
      return res.data;
    } catch (err) {
      if (err.response?.status !== 404) throw err;
      // If 404, fall through to create new file
    }
  }

  // Create new multipart file
  const boundary = '-------BrunoDriveBoundary' + Date.now();
  const metadataPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
    + JSON.stringify({ name: fileName, parents: [parentFolderId] })
    + '\r\n'
  );
  const mediaPartHeader = Buffer.from(
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const closingPart = Buffer.from(`\r\n--${boundary}--\r\n`);
  const multipartBody = Buffer.concat([metadataPart, mediaPartHeader, fileBuffer, closingPart]);

  const res = await axios({
    method: 'post',
    url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': multipartBody.length
    },
    data: multipartBody
  });

  return res.data;
};

// Download single file from Google Drive
const downloadSingleFile = async (accessToken, driveFileId, localDestinationPath) => {
  const dir = path.dirname(localDestinationPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const res = await axios.get(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer'
  });

  fs.writeFileSync(localDestinationPath, Buffer.from(res.data));
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

      if (!clientId || !clientSecret) {
        return reject(new Error('Vui lòng nhập Google Client ID và Secret trước khi đăng nhập.'));
      }

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

              const { access_token, refresh_token, expires_in, scope } = tokenRes.data;
              const grantedScopes = scope || '';
              if (!grantedScopes.includes('drive')) {
                if (authServer) authServer.close();
                return reject(
                  new Error(
                    'Bạn chưa cấp quyền truy cập Google Drive! Vui lòng: 1. Đảm bảo đã BẬT "Google Drive API" trên Google Cloud. 2. Khi đăng nhập, hãy TÍCH CHỌN ô cho phép Google Drive trước khi bấm Tiếp tục.'
                  )
                );
              }

              store.set('accessToken', access_token);
              if (refresh_token) {
                store.set('refreshToken', refresh_token);
              }
              store.set('expiresAt', Date.now() + (expires_in || 3600) * 1000);

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

  // Check diff between local and remote hash maps
  ipcMain.handle('gdrive:check-diff', async (event, { workspacePath, workspaceName }) => {
    try {
      if (!workspacePath || !fs.existsSync(workspacePath)) {
        throw new Error(`Đường dẫn Workspace không hợp lệ: ${workspacePath}`);
      }

      const accessToken = await getValidAccessToken();
      const mainFolder = await findOrCreateFolder(accessToken, 'Bruno Collections');
      const sanitizedName = (workspaceName || 'workspace').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
      const workspaceFolder = await findOrCreateFolder(accessToken, sanitizedName, mainFolder.id);

      const localMap = buildLocalHashMap(workspacePath);
      const { manifest } = await fetchRemoteManifest(accessToken, workspaceFolder.id);
      const remoteMap = manifest.files || {};

      const toUpload = [];
      const toDownload = [];
      let unchanged = 0;

      // Check local files against remote
      for (const [relPath, localItem] of Object.entries(localMap)) {
        const remoteItem = remoteMap[relPath];
        if (!remoteItem) {
          toUpload.push({ relPath, status: 'new' });
        } else if (remoteItem.hash !== localItem.hash) {
          toUpload.push({ relPath, status: 'modified' });
        } else {
          unchanged++;
        }
      }

      // Check remote files missing locally
      for (const [relPath] of Object.entries(remoteMap)) {
        if (!localMap[relPath]) {
          toDownload.push({ relPath, status: 'missing_locally' });
        }
      }

      return {
        totalLocalFiles: Object.keys(localMap).length,
        totalRemoteFiles: Object.keys(remoteMap).length,
        toUpload,
        toDownload,
        unchanged,
        folderUrl: workspaceFolder.webViewLink,
        lastRemoteSync: manifest.lastSynced || null
      };
    } catch (err) {
      throw formatApiError(err);
    }
  });

  // Hash Map Delta Sync (PUSH)
  ipcMain.handle('gdrive:sync-push', async (event, { workspacePath, workspaceName }) => {
    try {
      if (!workspacePath || !fs.existsSync(workspacePath)) {
        throw new Error(`Đường dẫn Workspace không hợp lệ: ${workspacePath}`);
      }

      const accessToken = await getValidAccessToken();
      const mainFolder = await findOrCreateFolder(accessToken, 'Bruno Collections');
      const sanitizedName = (workspaceName || 'workspace').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
      const workspaceFolder = await findOrCreateFolder(accessToken, sanitizedName, mainFolder.id);
      store.set('folderUrl', workspaceFolder.webViewLink);

      // 1. Build local hash map
      const localMap = buildLocalHashMap(workspacePath);

      // 2. Fetch remote manifest
      let { manifestFileId, manifest } = await fetchRemoteManifest(accessToken, workspaceFolder.id);
      const remoteMap = manifest.files || {};

      // 3. Diff: find files to upload
      const toUpload = [];
      let unchangedCount = 0;

      for (const [relPath, localItem] of Object.entries(localMap)) {
        const remoteItem = remoteMap[relPath];
        if (!remoteItem || remoteItem.hash !== localItem.hash) {
          toUpload.push({
            relPath,
            localItem,
            existingDriveId: remoteItem?.driveFileId || null
          });
        } else {
          unchangedCount++;
        }
      }

      // 4. Upload delta files
      const folderCache = { '': workspaceFolder.id };
      const updatedFiles = { ...remoteMap };

      for (const item of toUpload) {
        const fullPath = path.join(workspacePath, item.relPath);
        const parentFolderId = await resolveDriveFolderPath(
          accessToken,
          workspaceFolder.id,
          item.relPath,
          folderCache
        );
        const fileName = path.basename(item.relPath);

        const uploaded = await uploadSingleFile(
          accessToken,
          fullPath,
          fileName,
          parentFolderId,
          item.existingDriveId
        );

        updatedFiles[item.relPath] = {
          driveFileId: uploaded.id,
          hash: item.localItem.hash,
          size: item.localItem.size,
          mtime: item.localItem.mtime
        };
      }

      // 5. Update and upload new manifest.json
      const nowISO = new Date().toISOString();
      const newManifest = {
        workspaceName: sanitizedName,
        version: (manifest.version || 0) + 1,
        lastSynced: nowISO,
        syncedBy: os.hostname(),
        files: updatedFiles
      };

      manifestFileId = await saveRemoteManifest(
        accessToken,
        workspaceFolder.id,
        manifestFileId,
        newManifest
      );

      const lastSyncedDisplay = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      store.set('lastSynced', lastSyncedDisplay);

      return {
        success: true,
        uploadedCount: toUpload.length,
        unchangedCount,
        totalFiles: Object.keys(updatedFiles).length,
        lastSynced: lastSyncedDisplay,
        folderUrl: workspaceFolder.webViewLink
      };
    } catch (err) {
      throw formatApiError(err);
    }
  });

  // Hash Map Delta Sync (PULL - Download from Drive)
  ipcMain.handle('gdrive:sync-pull', async (event, { workspacePath, workspaceName }) => {
    try {
      if (!workspacePath || !fs.existsSync(workspacePath)) {
        throw new Error(`Đường dẫn Workspace không hợp lệ: ${workspacePath}`);
      }

      const accessToken = await getValidAccessToken();
      const mainFolder = await findOrCreateFolder(accessToken, 'Bruno Collections');
      const sanitizedName = (workspaceName || 'workspace').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
      const workspaceFolder = await findOrCreateFolder(accessToken, sanitizedName, mainFolder.id);

      // 1. Fetch remote manifest
      const { manifest } = await fetchRemoteManifest(accessToken, workspaceFolder.id);
      const remoteMap = manifest.files || {};

      if (Object.keys(remoteMap).length === 0) {
        throw new Error('Chưa có dữ liệu nào trên Google Drive cho Workspace này.');
      }

      // 2. Build local hash map
      const localMap = buildLocalHashMap(workspacePath);

      // 3. Diff: find files to download
      const toDownload = [];
      let unchangedCount = 0;

      for (const [relPath, remoteItem] of Object.entries(remoteMap)) {
        const localItem = localMap[relPath];
        if (!localItem || localItem.hash !== remoteItem.hash) {
          toDownload.push({ relPath, remoteItem });
        } else {
          unchangedCount++;
        }
      }

      // 4. Download changed files
      for (const item of toDownload) {
        const destPath = path.join(workspacePath, item.relPath);
        await downloadSingleFile(accessToken, item.remoteItem.driveFileId, destPath);
      }

      const lastSyncedDisplay = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      store.set('lastSynced', lastSyncedDisplay);

      return {
        success: true,
        downloadedCount: toDownload.length,
        unchangedCount,
        totalFiles: Object.keys(remoteMap).length,
        lastSynced: lastSyncedDisplay,
        folderUrl: workspaceFolder.webViewLink
      };
    } catch (err) {
      throw formatApiError(err);
    }
  });
};

module.exports = registerGoogleDriveIpc;
