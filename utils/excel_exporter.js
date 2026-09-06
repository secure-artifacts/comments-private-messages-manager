/**
 * FB 评论私信管家 - 评论收件箱版 CSV 导出工具
 */

const ExcelExporter = {
  exportLogsToCSV(logs, filename = 'FB_Inbox_Comment_Logs.csv') {
    if (!Array.isArray(logs) || logs.length === 0) {
      alert('当前没有可导出的日志数据！');
      return;
    }

    const headers = [
      '序号',
      '记录时间',
      '留言用户',
      '用户标识',
      '主页链接',
      '评论内容',
      '评论标识',
      '贴文标题',
      '贴文链接',
      '反向关键词',
      '私信状态',
      '处理原因',
      '日志级别'
    ];

    const rows = logs.map((item, index) => [
      index + 1,
      item.timestamp || '',
      item.userName || '',
      item.userKey || '',
      item.profileLink || '',
      item.commentText || '',
      item.commentKey || '',
      item.postTitle || '',
      item.postUrl || '',
      item.matchedKeyword || '',
      item.dmStatus || '',
      item.reason || '',
      item.level || 'info'
    ].map(csvCell));

    const BOM = '\uFEFF';
    const csv = BOM + [headers.map(csvCell).join(','), ...rows.map(row => row.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

if (typeof window !== 'undefined') window.ExcelExporter = ExcelExporter;
