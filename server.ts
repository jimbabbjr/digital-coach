import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdir, stat } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Dynamic file-based routing
async function setupRoutes() {
  const routesDir = join(__dirname, 'routes');
  
  try {
    await loadRoutesFromDir(routesDir, '');
  } catch (error) {
    console.log('Routes directory not found, skipping route setup');
  }
}

async function loadRoutesFromDir(dir: string, basePath: string) {
  const items = await readdir(dir);
  
  for (const item of items) {
    const fullPath = join(dir, item);
    const itemStat = await stat(fullPath);
    
    if (itemStat.isDirectory()) {
      await loadRoutesFromDir(fullPath, `${basePath}/${item}`);
    } else if (item.endsWith('.ts') || item.endsWith('.js')) {
      const [routeName, method, ext] = item.split('.');
      if (method && ['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())) {
        const routePath = basePath === '' ? `/${routeName}` : `${basePath}/${routeName}`;
        
        try {
          const module = await import(fullPath);
          const handler = module[method.toUpperCase()];
          
          if (handler) {
            app[method.toLowerCase() as keyof typeof app](routePath, async (req: any, res: any) => {
              try {
                const response = await handler(req);
                
                if (response instanceof Response) {
                  const text = await response.text();
                  const headers = Object.fromEntries(response.headers.entries());
                  res.set(headers);
                  res.status(response.status).send(text);
                } else {
                  res.json(response);
                }
              } catch (error) {
                console.error(`Error in ${routePath}:`, error);
                res.status(500).json({ error: 'Internal server error' });
              }
            });
            
            console.log(`✓ Loaded route: ${method.toUpperCase()} ${routePath}`);
          }
        } catch (error) {
          console.error(`Error loading route ${fullPath}:`, error);
        }
      }
    }
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 API server running on http://localhost:${PORT}`);
  await setupRoutes();
});