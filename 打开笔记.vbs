// 静默打开笔记站的网站（供桌面快捷方式调用，不弹黑窗口）
// 用法：wscript.exe 打开笔记.vbs
var url = 'https://ogurioguricap.github.io/my-notes/';
try {
  var sh = new ActiveXObject('WScript.Shell');
  sh.Run(url, 1, false);
} catch (e) {
  // 兜底：直接让系统用默认浏览器打开
  var sh2 = new ActiveXObject('Shell.Application');
  sh2.ShellExecute(url, '', '', 'open', 1);
}
