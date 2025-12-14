const { chromium } = require('playwright');
const admin = require('firebase-admin');

// --- CONFIGURACIÓN FIREBASE ---
if (process.env.FIREBASE_PRIVATE_KEY) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      })
    });
  } catch (err) {
    console.error("❌ Error inicializando Firebase:", err.message);
    process.exit(1);
  }
} else {
  console.error("⚠️ FALTAN LAS CLAVES DE FIREBASE");
  process.exit(1);
}

const db = admin.firestore();

// ⚠️ AQUÍ CAMBIAMOS EL NOMBRE DE LA COLECCIÓN PARA NO TOCAR 'APPOINTMENTS'
const COLLECTION_NAME = "homeserve_pendientes";

async function runRobot() {
  console.log('🤖 [V5.0] Arrancando robot (Columnas corregidas + Carpeta nueva)...');
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // --- PASO 1: LOGIN ---
    console.log('🔐 Entrando al login...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=PROF_PASS', { timeout: 60000 });

    const selectorUsuario = 'input[name="CODIGO"]';
    const selectorPass = 'input[type="password"]';

    if (await page.isVisible(selectorUsuario)) {
        await page.type(selectorUsuario, process.env.HOMESERVE_USER || '', { delay: 100 }); 
        await page.type(selectorPass, process.env.HOMESERVE_PASS || '', { delay: 100 });
        console.log('👆 Pulsando ENTER...');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5000); 
    }

    // --- PASO 2: IR A LA LISTA ---
    console.log('📂 Yendo a la Lista de Servicios...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    
    // --- PASO 3: LEER DATOS (CORRECCIÓN DE COLUMNAS) ---
    const servicios = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const datos = [];
      
      filas.forEach((tr) => {
        const tds = tr.querySelectorAll('td');
        
        // Solo miramos filas con datos (más de 5 columnas)
        if (tds.length > 5) {
            let ref = tds[0]?.innerText?.trim(); 
            
            // Validamos que sea un número de servicio real
            if (ref && !isNaN(ref.replace(/\D/g,'')) && ref.length > 3) { 
                
                // ⚠️ MAPEO CORREGIDO SEGÚN TUS INDICACIONES ⚠️
                // Col 0: Referencia (14852976)
                // Col 1: Cliente 
                // Col 2: Dirección 
                // Col 3: Población / Estado
                // Col 4: Fecha
                // Col 5: Teléfono

                // Ajustamos los índices [1], [2], [5] según lo que hemos visto
                datos.push({
                    serviceNumber: ref,
                    clientName: tds[1]?.innerText?.trim() || "Desconocido", 
                    address: tds[2]?.innerText?.trim() || "Sin dirección",
                    city: tds[3]?.innerText?.trim() || "",
                    dateString: tds[4]?.innerText?.trim(),
                    phone: tds[5]?.innerText?.trim() || "Sin teléfono",
                    
                    status: "pendiente_validacion",
                    insuranceCompany: "HOMESERVE",
                    createdAt: new Date().toISOString()
                });
            }
        }
      });
      return datos;
    });

    console.log(`📦 Encontrados: ${servicios.length} servicios.`);

    // --- PASO 4: GUARDAR EN LA NUEVA COLECCIÓN ---
    let guardados = 0;
    for (const s of servicios) {
      const docRef = db.collection(COLLECTION_NAME).doc(s.serviceNumber);
      const doc = await docRef.get();
      
      if (!doc.exists) {
        await docRef.set(s);
        console.log(`➕ Guardado en ${COLLECTION_NAME}: ${s.serviceNumber}`);
        guardados++;
      }
    }
    
    if (servicios.length > 0 && guardados === 0) {
        console.log("✅ No hay servicios NUEVOS (ya existen).");
    }

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    console.log('🏁 Fin V5.0');
    process.exit(0);
  }
}

runRobot();
