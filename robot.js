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
const COLLECTION_NAME = "homeserve_pendientes";

async function runRobot() {
  console.log('🤖 [V6.2] Arrancando robot (Limpieza de Teléfono)...');
  
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

    // --- PASO 2: OBTENER LISTA ---
    console.log('📂 Leyendo lista de servicios...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    
    const referenciasEnWeb = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const refs = [];
      filas.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length > 5) {
            let ref = tds[0]?.innerText?.trim();
            if (ref && !isNaN(ref.replace(/\D/g,'')) && ref.length > 3) {
                refs.push(ref);
            }
        }
      });
      return refs;
    });

    console.log(`🔎 Encontrados ${referenciasEnWeb.length} servicios.`);

    // --- PASO 3: PROCESAR UNO A UNO ---
    let actualizados = 0;
    let nuevos = 0;

    for (const ref of referenciasEnWeb) {
        
        const docRef = db.collection(COLLECTION_NAME).doc(ref);
        const docSnapshot = await docRef.get();
        let datosAntiguos = null;

        if (docSnapshot.exists) datosAntiguos = docSnapshot.data();

        // Navegar a la lista y hacer click (para refrescar sesión y datos)
        await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
        try {
            await page.click(`text="${ref}"`);
            await page.waitForTimeout(1500); 
        } catch (e) {
            console.error(`⚠️ No pude entrar en ficha ${ref}.`);
            continue;
        }

        // --- SCRAPING CON LIMPIEZA DE TELÉFONO ---
        const detalles = await page.evaluate(() => {
            const d = {};
            const filas = Array.from(document.querySelectorAll('tr'));
            filas.forEach(tr => {
                const celdas = tr.querySelectorAll('td');
                if (celdas.length >= 2) {
                    const clave = celdas[0].innerText.toUpperCase().trim();
                    const valor = celdas[1].innerText.trim(); // Texto sucio (con horas, nombres...)

                    // ⚠️ AQUÍ ESTÁ EL CAMBIO DE LIMPIEZA
                    if (clave.includes("TELEFONOS")) {
                        // Buscamos 9 dígitos seguidos que empiecen por 6,7,8 o 9
                        const match = valor.match(/[6789]\d{8}/);
                        // Si encontramos un número, nos quedamos SOLO con él. Si no, guardamos el texto original.
                        d.phone = match ? match[0] : valor;
                    }
                    
                    if (clave.includes("CLIENTE")) d.clientName = valor;
                    if (clave.includes("DOMICILIO")) d.addressPart = valor;
                    if (clave.includes("POBLACION")) d.cityPart = valor;
                    if (clave.includes("ACTUALMENTE EN")) d.status_homeserve = valor;
                    if (clave.includes("COMPAÑIA")) d.company = valor;
                    if (clave.includes("FECHA ASIGNACION")) d.dateString = valor;
                    if (clave.includes("COMENTARIOS")) d.description = valor;
                }
            });
            return d;
        });

        // --- PREPARACIÓN DE DATOS ---
        const fullAddress = `${detalles.addressPart || ""} ${detalles.cityPart || ""}`.trim();

        let rawCompany = detalles.company || "";
        if (!rawCompany.toUpperCase().includes("HOMESERVE")) {
            rawCompany = `HOMESERVE - ${rawCompany}`;
        }
        
        const servicioFinal = {
            serviceNumber: ref,
            clientName: detalles.clientName || "Desconocido",
            address: fullAddress, 
            phone: detalles.phone || "Sin teléfono", // Ahora vendrá limpio (solo números)
            description: detalles.description || "",
            homeserveStatus: detalles.status_homeserve || "",
            company: rawCompany,
            dateString: detalles.dateString || "",
            status: "pendiente_validacion",
            updatedAt: new Date().toISOString()
        };

        if (!datosAntiguos) servicioFinal.createdAt = new Date().toISOString();

        // --- GUARDADO INTELIGENTE ---
        if (!datosAntiguos) {
            await docRef.set(servicioFinal);
            console.log(`➕ NUEVO: ${ref} (Tlf: ${servicioFinal.phone})`);
            nuevos++;
        } else {
            // Comparamos estado O si el teléfono antes estaba sucio y ahora limpio
            const cambioEstado = datosAntiguos.homeserveStatus !== servicioFinal.homeserveStatus;
            const cambioTelefono = datosAntiguos.phone !== servicioFinal.phone;

            if (cambioEstado || cambioTelefono) {
                console.log(`♻️ ACTUALIZADO: ${ref}`);
                await docRef.set(servicioFinal, { merge: true });
                actualizados++;
            }
        }
    }

    console.log(`🏁 FIN V6.2: ${nuevos} nuevos, ${actualizados} actualizados.`);

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

runRobot();
