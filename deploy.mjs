/**
 * Deploy del frontend al hosting web (InfinityFree / ftpupload.net).
 *
 * Uso:
 *   1. Configura tus credenciales en `.env.deploy` (ver `.env.deploy.example`).
 *   2. Ejecuta `npm run build` para generar la carpeta `dist/`.
 *   3. Ejecuta `node deploy.mjs`.
 *
 * El script vacía el web root remoto (preservando los datos persistentes del
 * juego) y sube los archivos web desde la raíz local.
 */
import ftp from 'basic-ftp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env.deploy') });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.DEPLOY_HOST || 'ftpupload.net';
const PORT = Number(process.env.DEPLOY_PORT || 21);
const USER = process.env.DEPLOY_USER;
const PASS = process.env.DEPLOY_PASS;
const ROOT_DIR = __dirname;
const REMOTE_DIR = process.env.DEPLOY_DIR || 'htdocs';

// Lo que NO debe subirse al hosting: solo se publica el frontend (html/css/js/php/json).
const SKIP = new Set([
  '.env',
  '.env.deploy',
  '.env.local',
  '.git',
  '.gitignore',
  '.commandcode',
  'node_modules',
  'deploy.mjs',
  'package.json',
  'package-lock.json',
  'descargar_panos.py',
  'encontar-pano-valido.cjs',
  'panorama.html',
  'README.md',
  'dist',
]);

if (!USER || !PASS) {
  console.error('❌ Faltan DEPLOY_USER o DEPLOY_PASS.');
  console.error('   Crea el archivo .env.deploy copiando .env.deploy.example y rellena tus credenciales.');
  process.exit(1);
}

const client = new ftp.Client(30000);
client.ftp.verbose = false;

async function uploadFiltered(client, localDir) {
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const localPath = path.join(localDir, entry.name);
    if (entry.isDirectory()) {
      await client.ensureDir(entry.name);
      await uploadFiltered(client, localPath);
      await client.cdup();
    } else {
      await client.uploadFrom(localPath, entry.name);
    }
  }
}

async function run() {
  try {
    // Intentar primero FTP en claro; si el servidor lo exige, usar TLS explícito.
    try {
      await client.access({ host: HOST, port: PORT, user: USER, password: PASS, secure: false });
    } catch (err) {
      console.log('🔒 FTP en claro falló, reintentando con TLS explícito...');
      await client.access({ host: HOST, port: PORT, user: USER, password: PASS, secure: true });
    }
    console.log(`🔌 Conectado a ${HOST}:${PORT}`);

    // 1. Ir a la raíz y crear/entrar al web root (ensureDir deja el cwd dentro).
    await client.cd('/');
    await client.ensureDir(REMOTE_DIR);
    console.log(`📁 Directorio remoto: ${REMOTE_DIR}/`);

    // 2. Vaciar el web root, preservando los datos persistentes del juego
    //    (usuarios y leaderboard) para no resetear las puntuaciones.
    const PRESERVE = new Set(['users.json', 'leaderboard.json', 'rooms.json']);
    const remoto = await client.list('.');
    for (const item of remoto) {
      if (PRESERVE.has(item.name)) {
        console.log(`🔒 Preservado: ${item.name}`);
        continue;
      }
      if (item.isDirectory) {
        await client.removeDir(item.name);
        console.log(`🗑️  Dir eliminado: ${item.name}/`);
      } else {
        await client.remove(item.name);
        console.log(`🗑️  Archivo eliminado: ${item.name}`);
      }
    }

    // 3. Subir el frontend desde la raíz, ignorando tooling y secretos.
    await uploadFiltered(client, ROOT_DIR);
    console.log('🚀 Frontend subido correctamente.');

    // 4. Verificar.
    const remotoFinal = await client.list('.');
    console.log(`📋 Contenido remoto: ${remotoFinal.map((i) => i.name).join(', ')}`);
  } catch (err) {
    console.error('❌ Error durante el despliegue:', err.message);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

run();
