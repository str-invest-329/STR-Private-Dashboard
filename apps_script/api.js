// =============================================================================
// STR Alpha API 端點
// =============================================================================
// 部署為 Web App 後，前端可透過 fetch() 取得所有狀態表資料
// URL: https://script.google.com/macros/s/{DEPLOY_ID}/exec
//
// 用法：
//   GET ?action=all          → 回傳所有狀態表
//   GET ?action=market       → 只回傳市場狀態表
//   GET ?action=portfolio    → 只回傳全倉狀態表
//   GET ?action=equity       → 只回傳股票狀態表（帳戶+標的）
//   GET ?action=account      → 只回傳帳戶狀態表
//   GET ?action=prices       → 只回傳股票設定表
//   GET ?action=trades       → 只回傳股票事件表
//   GET ?action=account_events → 只回傳帳戶事件表
//   GET ?action=deposit_events → 只回傳定存事件表
//   GET ?action=deposits     → 只回傳定存狀態表
// =============================================================================

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || "all";
  var ss = SpreadsheetApp.openById("1_gy-srj_7ejRyEPt_b51dovt_Ka8caAyN9E6nEYxPF4");
  var result = {};

  try {
    switch (action) {
      case "all":
        result = getAllData(ss);
        break;
      case "market":
        result = { market_status: sheetToJson(ss, "市場狀態表") };
        break;
      case "portfolio":
        result = { portfolio_status: sheetToJson(ss, "全倉狀態表") };
        break;
      case "equity":
        result = {
          equity_by_account: sheetToJson(ss, "股票狀態表-帳戶"),
          equity_by_ticker: sheetToJson(ss, "股票狀態表-標的")
        };
        break;
      case "account":
        result = { account_status: sheetToJson(ss, "帳戶狀態表") };
        break;
      case "prices":
        result = { equity_prices: sheetToJson(ss, "股票設定表") };
        break;
      case "trades":
        result = { trade_events: sheetToJson(ss, "股票事件表") };
        break;
      case "account_events":
        result = { account_events: sheetToJson(ss, "帳戶事件表") };
        break;
      case "deposit_events":
        result = { deposit_events: sheetToJson(ss, "定存事件表") };
        break;
      case "deposits":
        result = { deposit_status: sheetToJson(ss, "定存狀態表-帳戶") };
        break;
      case "perf":
        result = { perf_events: sheetToJson(ss, "績效事件表(260101起)") };
        break;
      case "perf2":
        result = { perf_events2: sheetToJson(ss, "績效事件表(260501起)") };
        break;
      case "company_perf_us_1":
        result = { perf_events: sheetColsToJson(SpreadsheetApp.openById("1UWZJOBISEAXoMCXe3tZ9b_Nh4mjuMwn7tsqHfRduA_I"), "績效事件表(美股)", 1, 4) };
        break;
      case "company_perf_us_2":
        result = { perf_events2: sheetColsToJson(SpreadsheetApp.openById("1UWZJOBISEAXoMCXe3tZ9b_Nh4mjuMwn7tsqHfRduA_I"), "績效事件表(美股)", 7, 4) };
        break;
      case "company_perf_tw_1":
        result = { perf_events: sheetColsToJson(SpreadsheetApp.openById("1UWZJOBISEAXoMCXe3tZ9b_Nh4mjuMwn7tsqHfRduA_I"), "績效事件表(台股)", 1, 4) };
        break;
      case "company_perf_tw_2":
        result = { perf_events2: sheetColsToJson(SpreadsheetApp.openById("1UWZJOBISEAXoMCXe3tZ9b_Nh4mjuMwn7tsqHfRduA_I"), "績效事件表(台股)", 7, 4) };
        break;
      default:
        result = { error: "Unknown action: " + action };
    }

    result.timestamp = new Date().toISOString();
    result.status = "ok";

  } catch (err) {
    result = { status: "error", message: err.toString() };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 取得所有資料 =====
function getAllData(ss) {
  return {
    portfolio_status: sheetToJson(ss, "全倉狀態表"),
    market_status: sheetToJson(ss, "市場狀態表"),
    account_status: sheetToJson(ss, "帳戶狀態表"),
    equity_by_account: sheetToJson(ss, "股票狀態表-帳戶"),
    equity_by_ticker: sheetToJson(ss, "股票狀態表-標的"),
    equity_prices: sheetToJson(ss, "股票設定表"),
    deposit_status: sheetToJson(ss, "定存狀態表-帳戶"),
    account_config: sheetToJson(ss, "帳戶設定表")
  };
}

// ===== 工作表特定欄位範圍轉 JSON =====
function sheetColsToJson(ss, sheetName, startCol, numCols) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var headers = sheet.getRange(1, startCol, 1, numCols).getValues()[0];
  var data = sheet.getRange(2, startCol, sheet.getLastRow() - 1, numCols).getValues();
  var result = [];
  for (var i = 0; i < data.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      var key = String(headers[j]).trim();
      if (!key) continue;
      row[key] = data[i][j];
    }
    result.push(row);
  }
  return result;
}

// ===== 工作表轉 JSON =====
function sheetToJson(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();

  var result = [];
  for (var i = 0; i < data.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      var key = String(headers[j]).trim();
      if (!key) continue;
      row[key] = data[i][j];
    }
    result.push(row);
  }

  return result;
}
