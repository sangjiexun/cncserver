/**
 * @file Settings schema indexer.
 *
 */
/* eslint-disable global-require, import/no-dynamic-require */
module.exports = (cncserver) => {
  // TODO: Schemas to finalize: stroke, vectorize, text
  const items = ['projects', 'content', 'fill', 'stroke', 'path', 'text', 'vectorize'];
  const settingsKeys = ['fill', 'stroke', 'text', 'vectorize', 'path'];

  const schemas = {};
  const settingsKeySchemas = {};

  items.forEach((name) => {
    schemas[name] = require(`./cncserver.schemas.${name}.js`)(cncserver);
    if (settingsKeys.includes(name)) settingsKeySchemas[name] = schemas[name];
  });

  // Build the content "settings" schema.
  schemas.settings = require(
    './cncserver.schemas.content.settings.js'
  )(settingsKeySchemas);

  // Attach to content and projects schemas.
  schemas.content.properties.settings = schemas.settings;
  schemas.projects.properties.settings = schemas.settings;

  return schemas;
};
