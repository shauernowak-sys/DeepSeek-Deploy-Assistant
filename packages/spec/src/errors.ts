export const ERROR_CODES = {
  E_MANIFEST_INVALID: 'E_MANIFEST_INVALID',
  E_DOWNLOAD_HTTP: 'E_DOWNLOAD_HTTP',
  E_DOWNLOAD_NETWORK: 'E_DOWNLOAD_NETWORK',
  E_HASH_MISMATCH: 'E_HASH_MISMATCH',
  E_EXTRACT_UNSAFE_PATH: 'E_EXTRACT_UNSAFE_PATH',
  E_EXTRACT_FAILED: 'E_EXTRACT_FAILED',
  E_SPAWN_DENIED: 'E_SPAWN_DENIED',
  E_PROCESS_FAILED: 'E_PROCESS_FAILED',
  E_VERSION_UNSUPPORTED: 'E_VERSION_UNSUPPORTED',
  E_PROFILE_OWNED_BY_DESKTOP: 'E_PROFILE_OWNED_BY_DESKTOP',
  E_HARNESS_NOT_DEPLOYED: 'E_HARNESS_NOT_DEPLOYED',
  E_DISK_FULL: 'E_DISK_FULL',
  E_ROLLBACK_FAILED: 'E_ROLLBACK_FAILED',
  E_DECISION_REQUIRED: 'E_DECISION_REQUIRED',
  E_DECISION_STALE: 'E_DECISION_STALE',
  E_DECISION_BLOCKED: 'E_DECISION_BLOCKED',
  E_DECISION_UNCONFIRMED: 'E_DECISION_UNCONFIRMED',
  E_DISTRIBUTION_BLOCKED: 'E_DISTRIBUTION_BLOCKED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class DdaError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;

  constructor(code: ErrorCode, message: string, hint = '') {
    super(message);
    this.name = 'DdaError';
    this.code = code;
    this.hint = hint;
  }

  toJSON(): { code: ErrorCode; message: string; hint: string } {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

/** Mapping used by the UI and by diagnose rules (symptom -> cause -> action). */
export const DIAGNOSTICS: Record<ErrorCode, { cause: string; action: string }> = {
  E_MANIFEST_INVALID: { cause: '内置清单被篡改或版本不匹配', action: '重新安装应用；不要手工编辑 resources/manifests' },
  E_DOWNLOAD_HTTP: { cause: '下载源返回非 2xx（镜像失效或文件被移除）', action: '切换到备用源后重试；仍失败请检查网络代理' },
  E_DOWNLOAD_NETWORK: { cause: '网络中断或超时', action: '检查网络后点"继续"；已下载部分会续传' },
  E_HASH_MISMATCH: { cause: '下载内容与清单哈希不一致', action: '删除缓存后重试；若反复出现说明源被篡改，请更换源' },
  E_EXTRACT_UNSAFE_PATH: { cause: '压缩包包含越界路径（zip-slip）', action: '不要使用该压缩包；改用官方源重新下载' },
  E_EXTRACT_FAILED: { cause: '压缩包损坏或磁盘空间不足', action: '清理磁盘后重试；损坏包会被自动删除' },
  E_SPAWN_DENIED: { cause: '试图执行白名单外的命令', action: '这是安全拦截，请联系开发排查' },
  E_PROCESS_FAILED: { cause: '子进程以非 0 退出', action: '展开日志查看 stderr；复制诊断包反馈' },
  E_VERSION_UNSUPPORTED: { cause: '当前版本组合未经验证（如 latest 预发布）', action: '使用清单中锁定的版本组合' },
  E_PROFILE_OWNED_BY_DESKTOP: { cause: '目标是官方 Desktop 拥有的 profile', action: '请在该应用内操作；本工具不会修改它' },
  E_HARNESS_NOT_DEPLOYED: { cause: '本机还没有装好 Harness 运行时（Node / dsh）', action: '先完成"一键部署"（需联网），成功后再启动 Harness' },
  E_DISK_FULL: { cause: '磁盘空间不足', action: '至少预留 2 GB 后重试' },
  E_ROLLBACK_FAILED: { cause: '回滚时部分文件被占用', action: '关闭 Harness 后重试，或手动删除本次创建目录' },
  E_DECISION_REQUIRED: { cause: '没有先执行环境检测与安装决策', action: '回到「环境检测」重新检测后再部署' },
  E_DECISION_STALE: { cause: '安装决策已过期或来自旧的一次检测', action: '重新检测环境并再次确认' },
  E_DECISION_BLOCKED: { cause: '当前环境不满足部署条件，或仍需用户选择', action: '按界面提示处理阻塞项后再试' },
  E_DECISION_UNCONFIRMED: { cause: '用户尚未确认安装方案', action: '在确认页点「确认并开始部署」' },
  E_DISTRIBUTION_BLOCKED: {
    cause: '该组件的依赖许可不允许我方分发（离线包/镜像/重打包）',
    action: '改用在线安装；本软件只代为调用官方安装命令，不复制其字节',
  },
};
