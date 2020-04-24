/**
 * @file CNCServer ReSTful API endpoint for high level project content.
 */
const handlers = {};

module.exports = (cncserver) => {
  handlers['/v2/content'] = (req, res) => {
    const { content } = cncserver;

    // Enumerate content.
    if (req.route.method === 'get') {
      return {
        code: 200,
        body: {
          items: content.getItems(),
        },
      };
    }

    // Create a piece of content.
    if (req.route.method === 'post') {
      // Validate the request data against the schema before continuing.
      cncserver.schemas.validateData('content', req.body)
        .then(body => content.normalizeInput(body))
        .then(content.addItem)
        .then((item) => { res.status(200).send(item); })
        .catch((err) => {
          const errBody = {
            status: 'error',
            message: err.message || err,
          };

          if (err.stack) errBody.stack = err.stack.split('\n');
          res.status(406).send(errBody);
        });

      return true; // Tell endpoint wrapper we'll handle the response
    }

    // Error to client for unsupported request types.
    return false;
  };


  // Individual content management.
  handlers['/v2/content/:hash'] = (req, res) => {
    const { hash } = req.params;
    const { content, utils } = cncserver;
    const item = content.getResponseItem(hash);

    // Sanity check hash lookup.
    if (!item) {
      return [404, `Content with hash ID "${hash}" not found`];
    }

    // Display item.
    if (req.route.method === 'get') {
      return {
        code: 200,
        body: item,
      };
    }

    // Patch item.
    if (req.route.method === 'patch') {
      // Validate the request data against the schema before continuing.
      const mergedItem = utils.merge(item, req.body);

      // If a new source is given, replace the entire item in merged.
      if (req.body.source) {
        mergedItem.source = req.body.source;
      }

      cncserver.schemas.validateData('content', mergedItem)
        .then(() => content.editItem(item, req.body, mergedItem))
        .then((finalItem) => { res.status(200).send(finalItem); })
        .catch((err) => {
          const errBody = {
            status: 'error',
            message: err.message || err,
          };

          if (err.stack) errBody.stack = err.stack.split('\n');
          res.status(406).send(errBody);
        });

      return true; // Tell endpoint wrapper we'll handle the response
    }

    // Remove item.
    if (req.route.method === 'delete') {
      content.removeItem(hash);
      return [200, `Content identified by hash "${hash}" removed`];
    }

    // Error to client for unsupported request types.
    return false;
  };

  return handlers;
};