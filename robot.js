// Necesitas instalar esto en tu proyecto: npm install playwright

const { chromium } = require('playwright');

async function sincronizarHomeServe() {
  console.log('🤖 Iniciando robot de HomeServe...');
  
  // Lanzamos navegador (headless: true para que no se vea, false para ver qué hace)
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. IR AL LOGIN
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=PROF_PASS');
    
    // ⚠️ AQUÍ PONES LOS DATOS QUE INSPECCIONASTE ⚠️
    // Ejemplo: si el input se llama 'p_usuario', pones 'input[name="p_usuario"]'
    await page.fill('input[name="19768"]', 'TU_USUARIO');
    await page.fill('input[name="Pajarito15$"]', 'TU_CONTRASEÑA');
    
    // Clic en entrar y esperar a que cargue
    await Promise.all([
      page.waitForNavigation(), // Espera a cambiar de página
      page.click('button[type="submit"]') // O el selector del botón que veas
    ]);
    
    console.log('✅ Login completado (o eso creemos).');

    // 2. IR A LA LISTA "SECRETA"
    console.log('📂 Accediendo a la lista total...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');

    // 3. LEER LA TABLA (SCRAPING)
    // Esto busca todas las filas de la tabla. Puede variar según el HTML real.
    // Buscamos filas <tr> que tengan enlaces a servicios
    const servicios = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('tr')); // Coge todas las filas
      
      return filas.map(fila => {
        // Intentamos sacar datos de las columnas
        const columnas = fila.querySelectorAll('td');
        if (columnas.length < 3) return null; // Si es una fila vacía, saltar

        // Ejemplo: Columna 0 es ID, Columna 2 es Cliente... (esto hay que ajustarlo viendo la tabla real)
        return {
          id: columnas[0]?.innerText.trim(),
          cliente: columnas[2]?.innerText.trim(),
          direccion: columnas[3]?.innerText.trim()
        };
      }).filter(s => s && s.id); // Filtramos los nulos
    });

    console.log(`📦 Encontrados ${servicios.length} servicios.`);
    console.log(servicios);

    // AQUÍ IRÍA EL CÓDIGO PARA GUARDAR EN TU FIREBASE
    // ...

  } catch (error) {
    console.error('❌ Error del robot:', error);
  } finally {
    await browser.close();
  }
}

// Ejecutar prueba
sincronizarHomeServe();
