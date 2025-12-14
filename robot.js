const { chromium } = require('playwright');

async function modoDetective() {
  console.log('🕵️‍♂️ [MODO DETECTIVE] Iniciando investigación...');
  
  // Lanzamos con opciones para evitar bloqueos
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  }); 
  const page = await browser.newPage();

  try {
    console.log('🌍 Visitando la página de login...');
    // A veces HomeServe redirige, esperamos un poco
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=PROF_PASS', { timeout: 60000 });
    await page.waitForTimeout(3000); // Espera 3 seg a que cargue todo

    // 1. DIME EL TÍTULO (Para saber si cargó bien)
    const titulo = await page.title();
    console.log(`📑 Título de la página: "${titulo}"`);

    // 2. BUSCAR TODOS LOS INPUTS (Cajas de texto)
    // El robot nos dirá qué 'name' o 'id' tienen las cajas que ve.
    const inputs = await page.evaluate(() => {
        const campos = Array.from(document.querySelectorAll('input'));
        return campos.map(c => ({
            tipo: c.type,
            name: c.name,
            id: c.id,
            placeholder: c.placeholder,
            visible: c.offsetParent !== null // Truco para saber si se ve
        }));
    });

    console.log('🔎 HE ENCONTRADO ESTOS CAMPOS EN LA WEB:');
    console.log('------------------------------------------------');
    if (inputs.length === 0) {
        console.log("❌ ¡SOCORRO! No veo ningún campo (input). ¿Quizás hay un 'frame' o la web está en blanco?");
        // Si no hay inputs, imprimimos el HTML para ver qué pasa
        const html = await page.content();
        console.log("--- HTML DE LA PÁGINA (Primeros 500 caracteres) ---");
        console.log(html.substring(0, 500));
    } else {
        inputs.forEach(input => {
            console.log(`➡️  Tipo: [${input.tipo}] | Name: "${input.name}" | ID: "${input.id}" | Visible: ${input.visible}`);
        });
    }
    console.log('------------------------------------------------');
    console.log('💡 USA EL "NAME" O "ID" QUE VEAS ARRIBA PARA CORREGIR TU ROBOT REAL.');

  } catch (error) {
    console.error('❌ Error del detective:', error.message);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

modoDetective();
