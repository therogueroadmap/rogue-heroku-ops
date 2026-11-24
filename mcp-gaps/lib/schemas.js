'use strict';
const { z } = require('zod');
const { REV_PATTERN, RANGE_PATTERN, PATH_PATTERN, REV_MESSAGE, RANGE_MESSAGE } = require('./validate');

const PATH_MESSAGE = 'El parámetro path debe ser una ruta relativa con segmentos separados por / que empiecen por letra, número o _ y solo usen letras, números, _, . y -.';

// Los patrones son una primera barrera; argv.js sigue siendo la validación autoritativa.
function toolDefinitions(cfg) {
  const app = z.enum(cfg.apps).describe('App de Heroku configurada.');
  const rev = z.string().max(100).regex(REV_PATTERN, REV_MESSAGE).describe('HEAD, origin/<rama de despliegue> o un SHA hexadecimal de 7 a 40 caracteres.');
  const paths = z.array(z.string().max(4096).regex(PATH_PATTERN, PATH_MESSAGE)).max(20).optional().describe('Rutas relativas dentro del repositorio (máximo 20).');

  return {
    releases_list: {
      description: 'Lista los últimos releases de la app en Heroku (versión, descripción, estado, fecha y correo del autor).',
      inputSchema: { app, limit: z.number().int().min(1).max(50).optional().describe('Cantidad de releases (1 a 50, por defecto 10).') },
    },
    backup_info: {
      description: 'Muestra el estado de un backup de Postgres de la app, o del último si no indicas id.',
      inputSchema: { app, id: z.string().regex(/^[abr]\d{3,6}$/).optional().describe('Id del backup, por ejemplo b012.') },
    },
    backup_capture: {
      description: 'Captura un backup de Postgres de la app. Es una acción de escritura: úsala solo con autorización.',
      inputSchema: { app },
    },
    health_check: {
      description: 'Consulta la URL de health check configurada y devuelve el estado HTTP, la latencia y el inicio de la respuesta.',
      inputSchema: {},
    },
    git_fetch: {
      description: 'Ejecuta git fetch origin en el repositorio configurado para actualizar las referencias remotas.',
      inputSchema: {},
    },
    git_log: {
      description: 'Muestra el historial de git del repositorio configurado. Indica exactamente uno de rev o range (REV..REV).',
      inputSchema: {
        rev: rev.optional(),
        range: z.string().max(200).regex(RANGE_PATTERN, RANGE_MESSAGE).optional().describe('Rango REV..REV, con cada REV como en el parámetro rev.'),
        format: z.enum(['oneline', 'stat', 'name-only']).optional(),
        n: z.number().int().min(1).max(200).optional().describe('Cantidad de commits (1 a 200, por defecto 20).'),
        paths,
      },
    },
    git_show: {
      description: 'Muestra un commit o, si indicas path, el contenido de un archivo en esa revisión.',
      inputSchema: { rev, path: z.string().max(4096).regex(PATH_PATTERN, PATH_MESSAGE).optional().describe('Ruta relativa del archivo.'), format: z.enum(['stat', 'name-only']).optional() },
    },
    git_ls_tree: {
      description: 'Lista el árbol de archivos del repositorio en una revisión.',
      inputSchema: { rev, recursive: z.boolean().optional(), nameOnly: z.boolean().optional(), paths },
    },
    git_diff: {
      description: 'Muestra las diferencias entre dos revisiones del repositorio configurado.',
      inputSchema: { from: rev, to: rev, format: z.enum(['stat', 'name-only']).optional(), paths },
    },
  };
}

module.exports = { toolDefinitions };
