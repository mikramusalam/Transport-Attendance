/**
 * Optional Google Sheets sync via a Google Apps Script Web App webhook
 * (free — no Google Sheets API billing). PostgreSQL is always the source
 * of truth; this is best-effort and must never block attendance
 * submission. Failures here do not fail the request.
 */
export interface SheetsConfig {
  webhookUrl: string;
  sheetName: string;
  autoSync: boolean;
}

export interface SheetsSyncRecord {
  attendanceId: string;
  employeeCode: string;
  employeeName: string;
  truckNumber: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  latitude: number;
  longitude: number;
  gpsAccuracy: number;
  status: string;
  faceVerified: boolean;
  faceSimilarity: number | null;
  createdAt: string;
}

export async function syncRecordToGoogleSheets(
  record: SheetsSyncRecord,
  config: SheetsConfig
): Promise<{ success: boolean; message: string }> {
  if (!config.webhookUrl || !config.webhookUrl.startsWith('http')) {
    return { success: false, message: 'Webhook not configured' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'ADD_ATTENDANCE_ROW',
        sheetName: config.sheetName || 'AttendanceLog',
        record: {
          'Attendance ID': record.attendanceId,
          'Employee ID': record.employeeCode,
          'Employee Name': record.employeeName,
          'Truck Number': record.truckNumber,
          Date: record.date,
          Time: record.time,
          Latitude: record.latitude,
          Longitude: record.longitude,
          'GPS Accuracy (m)': record.gpsAccuracy,
          Status: record.status,
          'Face Verified': record.faceVerified,
          'Face Similarity': record.faceSimilarity,
          'Created At': record.createdAt,
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      return { success: true, message: 'Synced' };
    }
    return { success: false, message: `Webhook returned HTTP ${response.status}` };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Sync failed' };
  }
}

export function getGoogleAppsScriptTemplate(): string {
  return `function doPost(e) {
  var payload = JSON.parse(e.postData.contents);
  var sheetName = payload.sheetName || 'AttendanceLog';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

  var record = payload.record;
  var headers = Object.keys(record);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  sheet.appendRow(headers.map(function(h) { return record[h]; }));

  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}`;
}
