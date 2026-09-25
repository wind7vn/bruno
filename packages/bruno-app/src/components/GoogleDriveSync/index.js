import React, { useState, useEffect, useCallback } from 'react';
import { useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';

// Google Drive SVG Icon
const GoogleDriveIcon = ({ size = 18, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 87.3 78"
    className={className}
    style={{ display: 'inline-block', verticalAlign: 'middle' }}
  >
    <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
    <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47" />
    <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335" />
    <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
    <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
    <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
  </svg>
);

const GoogleDriveSync = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState({
    isConnected: false,
    user: null,
    lastSynced: null,
    folderUrl: null,
    clientId: '',
    clientSecret: ''
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [clientIdInput, setClientIdInput] = useState('');
  const [clientSecretInput, setClientSecretInput] = useState('');

  const { workspaces, activeWorkspaceUid } = useSelector((state) => state.workspaces);
  const activeWorkspace = workspaces?.find((w) => w.uid === activeWorkspaceUid);

  const fetchStatus = useCallback(async () => {
    if (!window.ipcRenderer) return;
    try {
      const res = await window.ipcRenderer.invoke('gdrive:get-status');
      if (res) {
        setStatus(res);
        if (res.clientId) setClientIdInput(res.clientId);
        if (res.clientSecret) setClientSecretInput(res.clientSecret);
      }
    } catch (err) {
      console.error('Failed to get Google Drive status:', err);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleSaveConfig = async (e) => {
    e?.preventDefault();
    if (!window.ipcRenderer) return;
    try {
      await window.ipcRenderer.invoke('gdrive:save-config', {
        clientId: clientIdInput.trim(),
        clientSecret: clientSecretInput.trim()
      });
      toast.success('Đã lưu cấu hình Google OAuth');
      setShowConfig(false);
      await fetchStatus();
    } catch (err) {
      toast.error('Lỗi khi lưu cấu hình');
    }
  };

  const handleLogin = async () => {
    if (!window.ipcRenderer) return;
    if (!status.clientId || !status.clientSecret) {
      setShowConfig(true);
      toast.error('Vui lòng nhập Google Client ID và Secret trước khi đăng nhập.');
      return;
    }

    setIsLoading(true);
    try {
      toast.loading('Đang mở trình duyệt để đăng nhập Google...', { id: 'gdrive-login' });
      const res = await window.ipcRenderer.invoke('gdrive:login');
      if (res && res.success) {
        toast.success(`Đã kết nối: ${res.user?.email || 'Google Drive'}`, { id: 'gdrive-login' });
        await fetchStatus();
      }
    } catch (err) {
      console.error(err);
      toast.error(err?.message || 'Đăng nhập Google Drive thất bại', { id: 'gdrive-login' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    if (!window.ipcRenderer) return;
    try {
      await window.ipcRenderer.invoke('gdrive:logout');
      toast.success('Đã đăng xuất Google Drive');
      setStatus((prev) => ({
        ...prev,
        isConnected: false,
        user: null,
        lastSynced: null,
        folderUrl: null
      }));
    } catch (err) {
      toast.error('Lỗi khi đăng xuất');
    }
  };

  const handleSync = async () => {
    if (!window.ipcRenderer) return;
    if (!activeWorkspace?.pathname) {
      toast.error('Không tìm thấy thư mục của Workspace hiện tại để đồng bộ.');
      return;
    }

    setIsSyncing(true);
    try {
      toast.loading(`Đang đồng bộ Workspace "${activeWorkspace.name}" lên Google Drive...`, { id: 'gdrive-sync' });
      const res = await window.ipcRenderer.invoke('gdrive:sync', {
        workspacePath: activeWorkspace.pathname,
        workspaceName: activeWorkspace.name || 'My Workspace'
      });

      if (res && res.success) {
        toast.success('Đồng bộ lên Google Drive thành công!', { id: 'gdrive-sync' });
        setStatus((prev) => ({
          ...prev,
          lastSynced: res.lastSynced,
          folderUrl: res.folderUrl
        }));
      }
    } catch (err) {
      console.error(err);
      toast.error(err?.message || 'Đồng bộ thất bại', { id: 'gdrive-sync' });
    } finally {
      setIsSyncing(false);
    }
  };

  const openFolder = () => {
    if (!window.ipcRenderer) return;
    window.ipcRenderer.openExternal(status.folderUrl || 'https://drive.google.com');
  };

  return (
    <>
      {/* Icon button on TitleBar */}
      <button
        onClick={() => {
          setIsOpen(true);
          fetchStatus();
        }}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md hover:bg-neutral-800 transition-colors border border-neutral-700/50"
        title="Google Drive Sync"
      >
        <GoogleDriveIcon size={15} />
        <span className="hidden sm:inline">Drive Sync</span>
        {status.isConnected && (
          <span className="w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20" />
        )}
      </button>

      {/* Modal */}
      {isOpen && (
        <Modal
          size="md"
          title="Đồng bộ Google Drive"
          handleCancel={() => setIsOpen(false)}
          hideFooter={true}
        >
          <div className="p-4 space-y-4 text-sm">
            {/* Header info */}
            <div className="flex items-center gap-3 p-3.5 rounded-xl bg-neutral-900/60 border border-neutral-800">
              <GoogleDriveIcon size={36} />
              <div>
                <h4 className="font-semibold text-base">Google Drive Cloud Backup</h4>
                <p className="text-xs text-neutral-400 mt-0.5">
                  Sao lưu toàn bộ Collections & Environments của Workspace lên Google Drive an toàn.
                </p>
              </div>
            </div>

            {!status.isConnected ? (
              /* State: Not connected */
              <div className="text-center py-6 px-4 rounded-xl border border-dashed border-neutral-800 space-y-4">
                <div className="space-y-1">
                  <p className="font-medium text-neutral-200">Chưa kết nối tài khoản Google</p>
                  <p className="text-xs text-neutral-400 max-w-sm mx-auto">
                    Bấm nút bên dưới để mở trình duyệt và cấp quyền lưu trữ vào thư mục riêng của Bruno.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleLogin}
                  disabled={isLoading}
                  className="inline-flex items-center justify-center gap-2.5 px-5 py-2.5 font-medium text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-all shadow-sm hover:shadow-blue-500/20 disabled:opacity-50"
                >
                  <GoogleDriveIcon size={18} />
                  <span>{isLoading ? 'Đang mở trình duyệt...' : 'Đăng nhập bằng Gmail'}</span>
                </button>
              </div>
            ) : (
              /* State: Connected */
              <div className="space-y-4">
                {/* User card */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-neutral-900 border border-neutral-800">
                  <div className="flex items-center gap-3">
                    {status.user?.picture ? (
                      <img
                        src={status.user.picture}
                        alt="Avatar"
                        className="w-10 h-10 rounded-full border border-neutral-700"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center font-bold text-white uppercase">
                        {status.user?.name?.[0] || 'G'}
                      </div>
                    )}
                    <div>
                      <div className="font-semibold text-sm text-neutral-100 flex items-center gap-2">
                        {status.user?.name || 'Google User'}
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          Đã kết nối
                        </span>
                      </div>
                      <div className="text-xs text-neutral-400">{status.user?.email}</div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleLogout}
                    className="text-xs text-red-400 hover:text-red-300 px-2.5 py-1 rounded hover:bg-red-500/10 transition-colors"
                  >
                    Đăng xuất
                  </button>
                </div>

                {/* Workspace & Sync info */}
                <div className="p-3.5 rounded-lg bg-neutral-900/40 border border-neutral-800 space-y-2.5 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="text-neutral-400">Workspace đang chọn:</span>
                    <span className="font-medium text-neutral-200">
                      {activeWorkspace?.name || 'Chưa chọn'}
                    </span>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-neutral-400">Thư mục Google Drive:</span>
                    <button
                      type="button"
                      onClick={openFolder}
                      className="text-blue-400 hover:underline inline-flex items-center gap-1 font-medium"
                    >
                      📁 Bruno Collections ↗
                    </button>
                  </div>

                  <div className="flex justify-between items-center pt-1 border-t border-neutral-800/60">
                    <span className="text-neutral-400">Lần đồng bộ gần nhất:</span>
                    <span className="text-neutral-300 font-mono">
                      {status.lastSynced || 'Chưa từng đồng bộ'}
                    </span>
                  </div>
                </div>

                {/* Big Sync Action Button */}
                <button
                  type="button"
                  onClick={handleSync}
                  disabled={isSyncing}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium text-white bg-emerald-600 hover:bg-emerald-500 active:scale-[0.99] transition-all shadow-lg shadow-emerald-900/30 disabled:opacity-50"
                >
                  <span className={isSyncing ? 'animate-spin' : ''}>🔄</span>
                  <span>
                    {isSyncing
                      ? 'Đang nén và đẩy lên Google Drive...'
                      : `Đồng bộ "${activeWorkspace?.name || 'Workspace'}" lên Drive`}
                  </span>
                </button>
              </div>
            )}

            {/* Optional OAuth Configuration Section */}
            <div className="pt-2 border-t border-neutral-800">
              <button
                type="button"
                onClick={() => setShowConfig(!showConfig)}
                className="text-xs text-neutral-400 hover:text-neutral-300 flex items-center justify-between w-full py-1"
              >
                <span>⚙️ Cấu hình Google OAuth Credentials</span>
                <span>{showConfig ? '▲ Đóng' : '▼ Mở'}</span>
              </button>

              {showConfig && (
                <form onSubmit={handleSaveConfig} className="mt-2 space-y-2.5 p-3 rounded-lg bg-neutral-900/80 border border-neutral-800 text-xs">
                  <div>
                    <label className="block text-neutral-400 mb-1">Google Client ID:</label>
                    <input
                      type="text"
                      value={clientIdInput}
                      onChange={(e) => setClientIdInput(e.target.value)}
                      placeholder="xxx.apps.googleusercontent.com"
                      className="w-full px-2.5 py-1.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-200 font-mono text-[11px]"
                    />
                  </div>
                  <div>
                    <label className="block text-neutral-400 mb-1">Client Secret:</label>
                    <input
                      type="password"
                      value={clientSecretInput}
                      onChange={(e) => setClientSecretInput(e.target.value)}
                      placeholder="GOCSPX-..."
                      className="w-full px-2.5 py-1.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-200 font-mono text-[11px]"
                    />
                  </div>
                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      className="px-3 py-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded font-medium"
                    >
                      Lưu cấu hình
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
};

export default GoogleDriveSync;
