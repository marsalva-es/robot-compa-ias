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
const COLLECTION_NAME = "appointments";

async function runRobot() {
  console.log('🤖 [V4.0] Arrancando robot (Versión DEFINITIVA)...');
  
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
        console.log("📝 Escribiendo usuario...");
        await page.type(selectorUsuario, process.env.HOMESERVE_USER || '', { delay: 100 }); 
        await page.type(selectorPass, process.env.HOMESERVE_PASS || '', { delay: 100 });
        
        console.log('👆 Pulsando ENTER para entrar...');
        await page.keyboard.press('Enter');
        
        // Esperamos a que cargue el menú
        await page.waitForTimeout(5000); 
    }

    // --- PASO 2: VERIFICACIÓN INTELIGENTE ---
    // En vez de mirar la URL, miramos si vemos el menú que tú me has pasado
    const textoPantalla = await page.innerText('body');

    if (textoPantalla.includes('PAGINA PRINCIPAL') || textoPantalla.includes('MANTENIMIENTO')) {
        console.log("✅ ¡LOGIN CORRECTO! Veo el menú principal.");
    } else if (textoPantalla.includes('Usuario incorrecto')) {
        throw new Error("Credenciales incorrectas.");
    } else {
        console.log("⚠️ No estoy seguro de dónde estoy, pero voy a intentar ir a la lista de todos modos.");
    }

    // --- PASO 3: IR A LA LISTA DE SERVICIOS ---
    console.log('📂 Yendo directo a la Lista de Servicios...');
    // Esta es la URL mágica donde están los datos
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    
    // --- PASO 4: LEER LA TABLA ---
    const servicios = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const datos = [];
      filas.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        // Si la fila tiene muchas columnas, es un servicio
        if (tds.length > 5) {
            let ref = tds[0]?.innerText?.trim(); // Columna 1: Referencia
            
            // Filtro de seguridad: ¿Es un número de verdad?
            if (ref && !isNaN(ref.replace(/\D/g,'')) && ref.length > 3) { 
                datos.push({
                    serviceNumber: ref,
                    clientName: tds[2]?.innerText?.trim(), // Columna 3: Cliente
                    address: tds[3]?.innerText?.trim(),    // Columna 4: Dirección
                    phone: tds[4]?.innerText?.trim(),      // Columna 5: Teléfono
                    status: "pendingStart",
                    createdAt: new Date().toISOString()
                });
            }
        }
      });
      return datos;
    });

    console.log(`📦 ¡HEMOS TRIUNFADO! Encontrados: ${servicios.length} servicios.`);

    // --- PASO 5: GUARDAR EN FIREBASE ---
    let guardados = 0;
    for (const s of servicios) {
      const docRef = db.collection(COLLECTION_NAME).doc(s.serviceNumber);
      const doc = await docRef.get();
      
      // Solo guardamos si NO existe ya (para no machacar datos)
      if (!doc.exists) {
        await docRef.set(s);
        console.log(`➕ Guardado en Firebase: ${s.serviceNumber}`);
        guardados++;
      }
    }
    
    if (servicios.length > 0 && guardados === 0) {
        console.log("✅ Todos los servicios ya estaban guardados. No hay novedades.");
    }

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    console.log('🏁 Misión cumplida.');
    process.exit(0);
  }
}

runRobot();
