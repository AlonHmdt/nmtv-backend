/**
 * TLS settings for Postgres connections.
 *
 * Supabase signs its database certificates with its own private CA
 * ("Supabase Root 2021 CA"), so Node can't verify them with the default
 * trust store. We load that CA explicitly and keep verification ON, so the
 * connection fails if the server isn't really Supabase.
 *
 * The CA file is public (downloaded from Supabase Dashboard → Database
 * Settings → SSL Configuration) and is committed at certs/supabase-ca-2021.crt.
 * Override the location with DATABASE_CA_CERT_PATH if needed.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CA_PATH = path.join(__dirname, 'certs', 'supabase-ca-2021.crt');

let cachedCa = null;

function loadCa() {
  if (cachedCa) return cachedCa;

  const caPath = process.env.DATABASE_CA_CERT_PATH || DEFAULT_CA_PATH;
  try {
    cachedCa = fs.readFileSync(caPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Database CA certificate not found at ${caPath}. ` +
      'Download it from Supabase Dashboard → Database Settings → SSL Configuration.'
    );
  }
  return cachedCa;
}

/** SSL options for pg: verify the server against the Supabase CA. */
function getDbSslConfig() {
  return {
    ca: loadCa(),
    rejectUnauthorized: true,
  };
}

module.exports = { getDbSslConfig };
