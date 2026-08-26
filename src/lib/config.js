import fs from 'node:fs';
import path from 'node:path';

// Chargement d'un .env sans dependance externe
const envPath = process.env.ENV_FILE || path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const ligne of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let valeur = m[2].trim();
    if (/^".*"$/.test(valeur) || /^'.*'$/.test(valeur)) valeur = valeur.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = valeur;
  }
}

const bool = (v, defaut = false) => (v === undefined || v === '' ? defaut : /^(true|1|oui|yes)$/i.test(v));
const num = (v, defaut) => (v === undefined || v === '' ? defaut : Number(v));
const liste = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export const config = {
  port: num(process.env.PORT, 3000),
  env: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'secret-de-developpement-a-remplacer-absolument',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',

  ldap: {
    url: process.env.LDAP_URL || 'ldap://localhost:389',
    bindDn: process.env.LDAP_BIND_DN || '',
    bindPassword: process.env.LDAP_BIND_PASSWORD || '',
    baseDn: process.env.LDAP_BASE_DN || '',
    userFilter: process.env.LDAP_USER_FILTER || '(&(objectClass=user)(objectCategory=person)(sAMAccountName={{login}}))',
    requiredGroup: process.env.LDAP_REQUIRED_GROUP || '',
    adminGroup: process.env.LDAP_ADMIN_GROUP || '',
    caFile: process.env.LDAP_CA_FILE || '',
    caBase64: process.env.LDAP_CA_BASE64 || '',
    rejectUnauthorized: bool(process.env.LDAP_TLS_REJECT_UNAUTHORIZED, true),
    autoriserNonChiffre: bool(process.env.LDAP_AUTORISER_NON_CHIFFRE, false),
  },

  service: {
    source: process.env.SERVICE_SOURCE || 'ou',
    attribut: process.env.SERVICE_ATTRIBUTE || 'department',
    ouDepth: num(process.env.SERVICE_OU_DEPTH, 1),
  },

  adminLogins: liste(process.env.ADMIN_LOGINS),

  sync: {
    // Un agent sans adresse ne recoit ni lancement ni relance : il ne jouera
    // jamais, tout en pesant sur le taux de participation de son service.
    exigerEmail: bool(process.env.SYNC_EXIGER_EMAIL, true),
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 25),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || 'Cybermois <cybermois@localhost>',
    groupeDiffusion: process.env.MAIL_GROUPE_DIFFUSION || '',
    copie: process.env.MAIL_COPIE || '',
    actif: bool(process.env.MAIL_ENVOI_ACTIF, false),
  },

  cron: {
    timezone: process.env.TIMEZONE || 'Europe/Paris',
    relance: process.env.CRON_RELANCE || '0 9 * * 3',
    resultats: process.env.CRON_RESULTATS || '0 16 * * 5',
  },

  campagne: {
    debut: process.env.CAMPAGNE_DEBUT || '2026-10-05',
    fin: process.env.CAMPAGNE_FIN || '2026-10-31',
  },

  dbFile: process.env.DB_FILE || path.resolve(process.cwd(), 'data', 'cybermois.db'),
};
