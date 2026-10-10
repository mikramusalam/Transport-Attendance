interface ExportRow {
  date: string;
  time: string;
  employeeCode: string;
  employeeName: string;
  truck: string;
  status: string;
  latitude: number;
  longitude: number;
  gpsAccuracy: number;
  faceVerified: boolean;
  livenessVerified: boolean | null;
  faceSimilarity: number | null;
  googleMapsLink: string;
}

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildAttendanceCsv(rows: ExportRow[]): string {
  const headers = [
    'Date',
    'Time',
    'Driver ID',
    'Driver Name',
    'Truck',
    'Status',
    'Latitude',
    'Longitude',
    'GPS Accuracy (m)',
    'Face Verification',
    'Liveness',
    'Face Similarity',
    'Google Maps Link',
  ];

  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.date,
        r.time,
        r.employeeCode,
        r.employeeName,
        r.truck,
        r.status,
        r.latitude,
        r.longitude,
        r.gpsAccuracy,
        r.faceVerified ? 'Verified' : 'Not Verified',
        r.livenessVerified === null ? 'N/A' : r.livenessVerified ? 'Passed' : 'Failed',
        r.faceSimilarity ?? '',
        r.googleMapsLink,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n');
}
