// ===== 去重檢查 =====
// 這個檔案不需要 onOpen、不需要重複宣告變數
// 所有設定和選單都在 MondaySync.gs 裡

// ===== 取得 board 上所有 items =====
function getAllItems(boardId) {
  var allItems = [];
  var cursor = null;

  while (true) {
    var cursorStr = cursor ? ', cursor: "' + cursor + '"' : '';
    var query = '{ boards(ids: ' + boardId + ') { items_page(limit: 100' + cursorStr + ') { cursor items { id name } } } }';

    var options = {
      method: "post",
      contentType: "application/json",
      headers: { "Authorization": MONDAY_TOKEN },
      payload: JSON.stringify({ query: query }),
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(MONDAY_API, options);
    var result = JSON.parse(response.getContentText());

    if (!result.data || !result.data.boards || !result.data.boards[0]) break;

    var page = result.data.boards[0].items_page;
    allItems = allItems.concat(page.items);

    if (!page.cursor || page.items.length === 0) break;
    cursor = page.cursor;

    Utilities.sleep(500);
  }

  return allItems;
}

// ===== 找出重複項 =====
function findDuplicates(items) {
  var seen = {};
  var duplicates = [];

  for (var i = 0; i < items.length; i++) {
    var name = items[i].name;
    if (seen[name]) {
      duplicates.push(items[i]);
    } else {
      seen[name] = items[i];
    }
  }

  return duplicates;
}

// ===== 檢查重複（僅報告） =====
function checkDuplicatesReport() {
  var report = [];

  for (var boardName in ALL_BOARDS) {
    var boardId = ALL_BOARDS[boardName];
    var items = getAllItems(boardId);
    var duplicates = findDuplicates(items);

    report.push(boardName + ": " + items.length + " 筆, 重複 " + duplicates.length + " 筆");

    if (duplicates.length > 0) {
      for (var i = 0; i < Math.min(duplicates.length, 10); i++) {
        report.push("  - " + duplicates[i].name + " (ID: " + duplicates[i].id + ")");
      }
      if (duplicates.length > 10) {
        report.push("  ...還有 " + (duplicates.length - 10) + " 筆");
      }
    }

    Utilities.sleep(1000);
  }

  SpreadsheetApp.getUi().alert("重複檢查報告\n\n" + report.join("\n"));
}

// ===== 檢查重複並刪除 =====
function checkDuplicatesAndDelete() {
  var ui = SpreadsheetApp.getUi();

  var totalDuplicates = 0;
  var boardDuplicates = {};

  for (var boardName in ALL_BOARDS) {
    var boardId = ALL_BOARDS[boardName];
    var items = getAllItems(boardId);
    var duplicates = findDuplicates(items);
    boardDuplicates[boardName] = duplicates;
    totalDuplicates += duplicates.length;
    Utilities.sleep(1000);
  }

  if (totalDuplicates === 0) {
    ui.alert("沒有發現重複項目！");
    return;
  }

  var response = ui.alert(
    "發現重複",
    "共發現 " + totalDuplicates + " 筆重複項目。\n\n確定要刪除嗎？（保留每個名稱的第一筆，刪除後面的重複項）",
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) return;

  var deleted = 0;
  var failed = 0;

  for (var boardName in boardDuplicates) {
    var duplicates = boardDuplicates[boardName];
    if (duplicates.length === 0) continue;

    for (var i = 0; i < duplicates.length; i += 5) {
      var batch = duplicates.slice(i, i + 5);
      var mutations = [];
      for (var j = 0; j < batch.length; j++) {
        mutations.push("d" + j + ": delete_item(item_id: " + batch[j].id + ") { id }");
      }
      var query = "mutation { " + mutations.join(" ") + " }";

      var options = {
        method: "post",
        contentType: "application/json",
        headers: { "Authorization": MONDAY_TOKEN },
        payload: JSON.stringify({ query: query }),
        muteHttpExceptions: true
      };

      try {
        var resp = UrlFetchApp.fetch(MONDAY_API, options);
        var result = JSON.parse(resp.getContentText());

        if (result.errors && JSON.stringify(result.errors).indexOf("COMPLEXITY_BUDGET_EXHAUSTED") >= 0) {
          Utilities.sleep(20000);
          resp = UrlFetchApp.fetch(MONDAY_API, options);
        }

        deleted += batch.length;
      } catch (e) {
        Logger.log("刪除失敗: " + e.toString());
        failed += batch.length;
      }

      Utilities.sleep(2000);
    }
  }

  ui.alert("刪除完成\n\n成功刪除: " + deleted + " 筆\n失敗: " + failed + " 筆");
}
