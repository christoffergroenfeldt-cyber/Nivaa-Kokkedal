/**
 * NKB — natlig backup af appens data (Supabase) til klubbens Google Drive.
 * Selvstændigt Apps Script-projekt i NKB's Google-konto (script.google.com → Nyt projekt → indsæt denne fil).
 * Kør installBackupTrigger() én gang: laver en kørsel hver nat ca. kl. 3 og tager den første backup med det samme.
 * Gemmer hele klubbens data (alle tabeller + indstillinger) som .json.gz i mappen "NKB backup (Supabase)". De seneste 30 dage beholdes.
 * BACKUP_KEY kan kun hente backup (dens SHA-256 ligger i public.kv som backup_key_sha) — den står ikke i GitHub.
 */
var SERVER_URL = 'https://rbsuittqekgaudmstpqu.supabase.co/functions/v1/api';
var BACKUP_KEY = '';   // udfyldes kun i den kopi, der indsættes i editoren
var BACKUP_FOLDER = 'NKB backup (Supabase)', BACKUP_KEEP_DAYS = 30;

function backupFolder_() {
  var pr = PropertiesService.getScriptProperties(), id = pr.getProperty('BACKUP_FOLDER');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* mappen er væk — opret en ny */ } }
  var nf = DriveApp.createFolder(BACKUP_FOLDER);
  pr.setProperty('BACKUP_FOLDER', nf.getId());
  return nf;
}
function backupSupabase() {
  if (!BACKUP_KEY) throw new Error('BACKUP_KEY mangler — brug den kopi, Claude sendte');
  var r = UrlFetchApp.fetch(SERVER_URL, { method: 'post', contentType: 'text/plain', payload: JSON.stringify({ action: 'export', key: BACKUP_KEY }), muteHttpExceptions: true });
  var txt = r.getContentText(), j = null;
  try { j = JSON.parse(txt); } catch (e) { j = null; }
  if (!j || !j.ok) throw new Error('Backup fejlede: ' + ((j && j.error) || ('HTTP ' + r.getResponseCode())));
  var name = 'nkb-' + Utilities.formatDate(new Date(), 'Europe/Copenhagen', 'yyyy-MM-dd-HHmm') + '.json';
  var folder = backupFolder_();
  folder.createFile(Utilities.gzip(Utilities.newBlob(txt, 'application/json', name), name + '.gz'));
  var cut = Date.now() - BACKUP_KEEP_DAYS * 86400000, it = folder.getFiles();
  while (it.hasNext()) { var f = it.next(); if (/^nkb-.*\.json\.gz$/.test(f.getName()) && f.getDateCreated().getTime() < cut) f.setTrashed(true); }
  Logger.log('Backup gemt: ' + name + '.gz (' + Math.round(txt.length / 1024) + ' KB) · ' + JSON.stringify(j.counts));
}
function installBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'backupSupabase') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('backupSupabase').timeBased().everyDays(1).atHour(3).inTimezone('Europe/Copenhagen').create();
  Logger.log('Natlig backup installeret (ca. kl. 3). Tager den første backup nu …');
  backupSupabase();
  Logger.log('Mappe: ' + backupFolder_().getUrl());
}
