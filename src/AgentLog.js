// Decision log: every add/update/delete/skip with its reason. Goes to the execution log (console)
// and to the "Log" tab of the log spreadsheet created by setup().

var AgentLog = (function () {
  var HEADER = ['Time (IST)', 'Mode', 'Action', 'Who', 'Title', 'When', 'Confidence', 'Reason', 'Source', 'Meeting id'];
  var rows = [], mode = 'LIVE';

  function start(m) { rows = []; mode = m; }

  function add(e) {
    var row = [new Date(), mode, e.action || '', e.who || '', e.title || '', e.when || '',
      e.confidence === undefined || e.confidence === null ? '' : Number(e.confidence).toFixed(2),
      e.reason || '', e.link || '', e.meetingId || ''];
    rows.push(row);
    console.log([mode, e.action, e.who, e.title, e.when, e.confidence !== undefined ? 'conf=' + e.confidence : '', e.reason, e.link]
      .filter(function (x) { return x !== undefined && x !== null && x !== ''; }).join(' | '));
  }

  function flush() {
    var id = props_().getProperty('LOG_SHEET_ID');
    if (!id || !rows.length) return;
    try {
      var sheet = SpreadsheetApp.openById(id).getSheetByName('Log');
      if (sheet.getLastRow() === 0) sheet.appendRow(HEADER);
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADER.length).setValues(rows);
      if (sheet.getLastRow() > 20000) sheet.deleteRows(2, 5000);
    } catch (e) {
      console.warn('Could not write log sheet: ' + e);
    }
    rows = [];
  }

  return { start: start, add: add, flush: flush, HEADER: HEADER };
})();
