import type { JSX } from 'react';

type Scene = 'download' | 'extract' | 'launch' | 'check' | 'login';

/** Diagrammatic illustrations, not screenshots of SnowLuma or Windows. */
export function SetupIllustration({ scene }: { scene: Scene }): JSX.Element {
  return (
    <svg className="setup-illustration" viewBox="0 0 360 200" role="img" aria-label={{ download: '在官方下载页面选择 Windows 完整版压缩包的示意图', extract: '右键压缩包并选择全部解压的示意图', launch: '打开解压后的文件夹并双击启动文件的示意图', check: '回到本应用检测安装的示意图', login: '在浏览器打开 SnowLuma 并使用手机 QQ 扫码的示意图' }[scene]}>
      <rect x="1" y="1" width="358" height="198" rx="16" fill="#edf4ff" />
      {scene === 'download' && <>
        <rect x="30" y="22" width="300" height="156" rx="10" fill="#fff" stroke="#c6d6ef" strokeWidth="2" />
        <path d="M30 48h300" stroke="#d9e4f5" strokeWidth="2"/><circle cx="46" cy="35" r="3" fill="#9eb4d4"/><circle cx="58" cy="35" r="3" fill="#9eb4d4"/><circle cx="70" cy="35" r="3" fill="#9eb4d4"/>
        <rect x="48" y="66" width="100" height="8" rx="4" fill="#a5bbdc"/><rect x="48" y="84" width="264" height="39" rx="7" fill="#e5efff" stroke="#5d92f4" strokeWidth="2"/>
        <path d="M66 91v21m-6-6 6 6 6-6m-12 11h12" fill="none" stroke="#165cf0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        <text x="88" y="109" fill="#16438c" fontSize="14" fontWeight="600">Windows x64 · ZIP</text>
        <rect x="48" y="134" width="180" height="8" rx="4" fill="#dbe5f3"/><path d="m268 116 17 28 4-12 12-4z" fill="#165cf0" stroke="#fff" strokeWidth="2"/>
      </>}
      {scene === 'extract' && <>
        <rect x="36" y="25" width="288" height="150" rx="10" fill="#fff" stroke="#c6d6ef" strokeWidth="2"/>
        <path d="M36 51h288" stroke="#d9e4f5" strokeWidth="2"/><path d="M63 86h45l10 10h28v42H63z" fill="#ffd980" stroke="#d8a645" strokeWidth="2"/><path d="M101 87v44m-5-37h10m-10 9h10m-10 9h10" stroke="#b78b37" strokeWidth="2"/>
        <rect x="164" y="65" width="132" height="88" rx="7" fill="#fff" stroke="#c6d6ef"/><rect x="171" y="103" width="118" height="30" rx="5" fill="#e5efff"/>
        <text x="181" y="123" fill="#16438c" fontSize="14" fontWeight="600">全部解压...</text><path d="m266 126 15 24 3-10 10-3z" fill="#165cf0" stroke="#fff" strokeWidth="2"/>
      </>}
      {scene === 'launch' && <>
        <rect x="30" y="22" width="300" height="156" rx="10" fill="#fff" stroke="#c6d6ef" strokeWidth="2"/><path d="M30 48h300" stroke="#d9e4f5" strokeWidth="2"/>
        <path d="M50 67h30l8 8h22v25H50z" fill="#ffd980"/><rect x="49" y="112" width="260" height="38" rx="6" fill="#e5efff" stroke="#6a9cf5" strokeWidth="2"/>
        <rect x="62" y="121" width="23" height="20" rx="3" fill="#1e3151"/><path d="m67 127 4 4-4 4m6 0h6" fill="none" stroke="#fff" strokeWidth="1.5"/>
        <text x="97" y="137" fill="#16438c" fontSize="14" fontWeight="600">launcher.bat</text><path d="m255 142 16 24 3-10 10-3z" fill="#165cf0" stroke="#fff" strokeWidth="2"/>
      </>}
      {scene === 'check' && <>
        <rect x="35" y="24" width="290" height="148" rx="11" fill="#fff" stroke="#c6d6ef" strokeWidth="2"/>
        <circle cx="180" cy="72" r="24" fill="#e7f0ff"/><path d="m169 72 8 8 15-17" fill="none" stroke="#165cf0" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
        <rect x="85" y="112" width="190" height="36" rx="8" fill="#165cf0"/><text x="180" y="135" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="600">我已完成安装，开始检测</text>
      </>}
      {scene === 'login' && <>
        <rect x="27" y="27" width="225" height="138" rx="10" fill="#fff" stroke="#c6d6ef" strokeWidth="2"/><path d="M27 53h225" stroke="#d9e4f5" strokeWidth="2"/>
        <rect x="95" y="70" width="77" height="77" rx="5" fill="#f1f5fc" stroke="#b7cae7"/><path d="M106 81h16v16h-16zm39 0h16v16h-16zm-39 39h16v16h-16zm22-18h8v8h-8zm15 13h8v8h-8zm-10 13h8v8h-8z" fill="#6887b5"/>
        <text x="139" y="157" textAnchor="middle" fill="#526d96" fontSize="10">示意图，不能扫码</text><rect x="264" y="42" width="61" height="116" rx="12" fill="#fff" stroke="#6288bc" strokeWidth="3"/><rect x="271" y="55" width="47" height="82" rx="5" fill="#e5efff"/><circle cx="294.5" cy="148" r="3" fill="#8aa5cb"/><path d="m255 93-14 0m8-7-8 7 8 7" fill="none" stroke="#165cf0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
      </>}
    </svg>
  );
}
