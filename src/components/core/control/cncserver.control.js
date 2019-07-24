/**
 * @file Abstraction module for functions that generate movement or help
 * functions for calculating movement command generation for CNC Server!
 */
const control = {}; // Exposed export.

module.exports = (cncserver) => {
  /**
   * Run the operation to set the current tool (and any aggregate operations
   * required) into the buffer
   *
   * @param toolName
   *   The machine name of the tool (as defined in the bot config file).
   * @param callback
   *   Triggered when the full tool change is to have been completed, or on
   *   failure.
   *
   * @returns {boolean}
   *   True if success, false on failure.
   */
  control.setTool = (toolName, callback, ignoreTimeout) => {
    // Parse out any virtual indexes (pipe delimited) from the tool name.
    // These are passed by clients to assist users for manual tool swaps, but
    // doesn't actually do anything differently.
    const toolNameData = toolName.split('|');
    const [currentToolName, vIndex] = toolNameData[1];

    // Get the matching tool object from the bot configuration.
    const tool = cncserver.settings.botConf.get(`tools:${currentToolName}`);

    // No tool found with that name? Augh! Run AWAY!
    if (!tool) {
      if (callback) {
        cncserver.run('callback', callback);
      }
      return false;
    }

    // Set the height based on what kind of tool it is
    // TODO: fold this into bot specific tool change logic
    const downHeight = currentToolName.indexOf('water') !== -1 ? 'wash' : 'draw';

    // Pen Up
    cncserver.pen.setHeight('up');

    // Move to the tool
    cncserver.control.movePenAbs(tool);

    // A "wait" tool requires user feedback before it can continue.
    if (typeof tool.wait !== 'undefined') {
      // Queue a callback to pause continued execution on tool.wait value
      if (tool.wait) {
        const { lastDuration: moveDuration } = cncserver.pen.state;
        cncserver.run('callback', () => {
          cncserver.buffer.pause();
          cncserver.buffer.setNewlyPaused(true);

          // Trigger the manualswap with virtual index for the client/user.
          cncserver.buffer.setPauseCallback(() => {
            setTimeout(() => {
              cncserver.sockets.manualSwapTrigger(vIndex);
            }, moveDuration);
          });
        });
      }
    } else { // "Standard" WaterColorBot toolchange
      // Pen down
      cncserver.pen.setHeight(downHeight);

      // Wiggle the brush a bit
      cncserver.control.wigglePen(
        tool.wiggleAxis,
        tool.wiggleTravel,
        tool.wiggleIterations
      );

      // Put the pen back up when done!
      cncserver.pen.setHeight('up');
    }

    // If there's a callback to run...
    if (callback) {
      if (!ignoreTimeout) { // Run inside the buffer
        cncserver.run('callback', callback);
      } else { // Run as soon as items have been buffered
        callback(1);
      }
    }

    return true;
  };

  /**
   * "Move" the pen (tip of the buffer) to an absolute point inside the maximum
   * available bot area. Includes cutoffs and sanity checks.
   *
   * @param {{x: number, y: number, [limit: string]}} inPoint
   *   Absolute coordinate measured in steps to move to. src is assumed to be
   *   "pen" tip of buffer. Also can contain optional "limit" key to set where
   *   movement should be limited to. Defaults to none, accepts "workArea".
   * @param {function} callback
   *   Callback triggered when operation should be complete.
   * @param {boolean} immediate
   *   Set to true to trigger the callback immediately.
   * @param {boolean} skip
   *    Set to true to skip adding to the buffer, simplifying this function
   *    down to just a sanity checker.
   *
   * @returns {number}
   *   Distance moved from previous position, in steps.
   */
  control.movePenAbs = (inPoint, callback, immediate, skip) => {
    // Something really bad happened here...
    if (Number.isNaN(inPoint.x) || Number.isNaN(inPoint.y)) {
      console.error('INVALID Move pen input, given:', inPoint);
      if (callback) callback(false);
      return 0;
    }

    // Make a local copy of point as we don't want to mess with its values ByRef
    const point = cncserver.utils.extend({}, inPoint);

    // Sanity check absolute position input point and round everything (as we
    // only move in whole number steps)
    point.x = Math.round(Number(point.x));
    point.y = Math.round(Number(point.y));

    // If moving in the workArea only, limit to allowed workArea, and trigger
    // on/off screen events when we go offscreen, retaining suggested position.
    let startOffCanvasChange = false;
    if (point.limit === 'workArea') {
      // Off the Right
      if (point.x > cncserver.settings.bot.workArea.right) {
        point.x = cncserver.settings.bot.workArea.right;
        startOffCanvasChange = true;
      }

      // Off the Left
      if (point.x < cncserver.settings.bot.workArea.left) {
        point.x = cncserver.settings.bot.workArea.left;
        startOffCanvasChange = true;
      }

      // Off the Top
      if (point.y < cncserver.settings.bot.workArea.top) {
        point.y = cncserver.settings.bot.workArea.top;
        startOffCanvasChange = true;
      }

      // Off the Bottom
      if (point.y > cncserver.settings.bot.workArea.bottom) {
        point.y = cncserver.settings.bot.workArea.bottom;
        startOffCanvasChange = true;
      }

      // Are we beyond our workarea limits?
      if (startOffCanvasChange) { // Yep.
        // We MUST trigger the start offscreen change AFTER the movement to draw
        // up to that point (which happens later).
        startOffCanvasChange = true;
      } else { // Nope!
        // The off canvas STOP trigger must happen BEFORE the move happens
        // (which is fine right here)
        cncserver.control.offCanvasChange(false);
      }
    }

    // Ensure values don't go off the rails
    cncserver.utils.sanityCheckAbsoluteCoord(point);

    // If we're skipping the buffer, just move to the point
    // Pen stays put as last point set in buffer
    if (skip) {
      console.log('Skipping buffer for:', point);
      cncserver.control.actuallyMove(point, callback);
      return 0; // Don't return any distance for buffer skipped movements
    }

    // Calculate change from end of buffer pen position
    const source = { x: cncserver.pen.state.x, y: cncserver.pen.state.y };
    const change = {
      x: Math.round(point.x - cncserver.pen.state.x),
      y: Math.round(point.y - cncserver.pen.state.y),
    };

    // Don't do anything if there's no change
    if (change.x === 0 && change.y === 0) {
      if (callback) callback(cncserver.pen.state);
      return 0;
    }

    /*
     Duration/distance is only calculated as relative from last assumed point,
     which may not actually ever happen, though it is likely to happen.
     Buffered items may not be pushed out of order, but previous location may
     have changed as user might pause the buffer, and move the actualPen
     position.
     @see executeNext - for more details on how this is handled.
    */
    const distance = cncserver.utils.getVectorLength(change);
    const duration = cncserver.utils.getDurationFromDistance(distance);

    // Only if we actually moved anywhere should we queue a movement
    if (distance !== 0) {
      // Set the tip of buffer pen at new position
      cncserver.pen.forceState({
        x: point.x,
        y: point.y,
      });

      // Adjust the distance counter based on movement amount, not if we're off
      // the canvas though.
      if (cncserver.utils.penDown()
          && !cncserver.pen.state.offCanvas
          && cncserver.settings.bot.inWorkArea(point)) {
        cncserver.pen.forceState({
          distanceCounter: parseFloat(
            Number(distance) + Number(cncserver.pen.state.distanceCounter)
          ),
        });
      }

      // Queue the final absolute move (serial command generated later)
      cncserver.run(
        'move',
        {
          x: cncserver.pen.state.x,
          y: cncserver.pen.state.y,
          source,
        },
        duration
      );
    }

    // Required start offCanvas change -after- movement has been queued
    if (startOffCanvasChange) {
      cncserver.control.offCanvasChange(true);
    }

    if (callback) {
      if (immediate === true) {
        callback(cncserver.pen.state);
      } else {
        // Set the timeout to occur sooner so the next command will execute
        // before the other is actually complete. This will push into the buffer
        // and allow for far smoother move runs.

        const latency = cncserver.settings.gConf.get('bufferLatencyOffset');
        const cmdDuration = Math.max(duration - latency, 0);

        if (cmdDuration < 2) {
          callback(cncserver.pen.state);
        } else {
          setTimeout(() => {
            callback(cncserver.pen.state);
          }, cmdDuration);
        }
      }
    }

    return distance;
  };

  /**
   * Triggered when the pen is requested to move across the bounds of the draw
   * area (either in or out).
   *
   * @param {boolean} newValue
   *   Pass true when moving "off screen", false when moving back into bounds
   */
  control.offCanvasChange = (newValue) => {
    // Only do anything if the value is different
    if (cncserver.pen.state.offCanvas !== newValue) {
      cncserver.pen.forceState({ offCanvas: newValue });
      if (cncserver.pen.state.offCanvas) { // Pen is now off screen/out of bounds
        if (cncserver.utils.penDown()) {
          // Don't draw stuff while out of bounds (also, don't change the
          // current known state so we can come back to it when we return to
          // bounds),but DO change the buffer tip height so that is reflected on
          // actualPen if it's every copied over on buffer execution.
          cncserver.run('callback', () => {
            cncserver.pen.setHeight('up', false, true);
            const { height } = cncserver.utils.stateToHeight('up');
            cncserver.pen.forceState({ height });
          });
        }
      } else { // Pen is now back in bounds
        // Set the state regardless of actual change
        const { state: back } = cncserver.pen.state;
        console.log('Go back to:', back);

        // Assume starting from up state & height (ensures correct timing)
        cncserver.pen.forceState({
          state: 'up',
          height: cncserver.utils.stateToHeight('up').height,
        });
        cncserver.pen.setHeight(back);
      }
    }
  };

  /**
   * Actually move the position of the pen, called inside and outside buffer
   * runs, figures out timing/offset based on actualPen position.
   *
   * @param {{x: number, y: number}} destination
   *   Absolute destination coordinate position (in steps).
   * @param {function} callback
   *   Optional, callback for when operation should have completed.
   */
  control.actuallyMove = (destination, callback) => {
    // Get the amount of change/duration from difference between actualPen and
    // absolute position in given destination
    const change = cncserver.utils.getPosChangeData(
      cncserver.actualPen.state,
      destination
    );

    control.commandDuration = Math.max(change.d, 0);

    // Execute the command immediately via serial.direct.command.
    cncserver.ipc.sendMessage('serial.direct.command', {
      commands: cncserver.buffer.render({
        command: {
          type: 'absmove',
          x: destination.x,
          y: destination.y,
          source: cncserver.actualPen.state,
        },
        duration: cncserver.control.commandDuration,
      }),
    });

    // Set the correct duration and new position through to actualPen
    cncserver.actualPen.forceState({
      lastDuration: change.d,
      x: destination.x,
      y: destination.y,
    });

    // If there's nothing in the buffer, reset pen to actualPen
    if (cncserver.buffer.data.length === 0) {
      cncserver.pen.resetState();
    }

    // Trigger an update for pen position
    cncserver.sockets.sendPenUpdate();

    // Delayed callback (if used)
    if (callback) {
      setTimeout(() => {
        callback(1);
      }, Math.max(cncserver.control.commandDuration, 0));
    }
  };

  /**
   * Actually change the height of the pen, called inside and outside buffer
   * runs, figures out timing offset based on actualPen position.
   *
   * @param {integer} height
   *   Write-ready servo "height" value calculated from "state"
   * @param {string} stateValue
   *   Optional, pass what the name of the state should be saved as in the
   *   actualPen object when complete.
   * @param {function} cb
   *   Optional, callback for when operation should have completed.
   */
  control.actuallyMoveHeight = (height, stateValue, cb) => {
    const change = cncserver.utils.getHeightChangeData(
      cncserver.actualPen.state.height,
      height
    );

    control.commandDuration = Math.max(change.d, 0);

    // Pass along the correct height position through to actualPen.
    if (typeof stateValue !== 'undefined') {
      cncserver.actualPen.forceState({ state: stateValue });
    }

    // Execute the command immediately via serial.direct.command.
    cncserver.ipc.sendMessage('serial.direct.command', {
      commands: cncserver.buffer.render({
        command: {
          type: 'absheight',
          z: height,
          source: cncserver.actualPen.state.height,
        },
        duration: cncserver.control.commandDuration,
      }),
    });

    cncserver.actualPen.forceState({
      height,
      lastDuration: change.d,
    });

    // Trigger an update for pen position.
    cncserver.sockets.sendPenUpdate();

    // Delayed callback (if used)
    if (cb) {
      setTimeout(() => {
        cb(1);
      }, Math.max(cncserver.control.commandDuration, 0));
    }
  };

  /**
   * Util function to buffer the "wiggle" movement for WaterColorBot Tool
   * changes. TODO: Replace this with a real API for tool changes.
   *
   * @param {string} axis
   *   Which axis to move along. Either 'xy' or 'y'
   * @param {integer} rawTravel
   *   How much to move during the wiggle.
   * @param {integer} iterations
   *   How many times to move.
   */
  control.wigglePen = (axis, rawTravel, iterations) => {
    const start = { x: Number(cncserver.pen.state.x), y: Number(cncserver.pen.state.y) };
    let i = 0;
    const travel = Number(rawTravel); // Make sure it's not a string

    function _wiggleSlave(toggle) {
      const point = { x: start.x, y: start.y };

      if (axis === 'xy') {
        const rot = i % 4; // Ensure rot is always 0-3

        // This convoluted series ensure the wiggle moves in a proper diamond
        if (rot % 3) { // Results in F, T, T, F
          if (toggle) {
            point.y += travel / 2; // Down
          } else {
            point.x -= travel; // Left
          }
        }

        if (toggle) {
          point.y -= travel / 2; // Up
        } else {
          point.x += travel; // Right
        }
      } else {
        point[axis] += (toggle ? travel : travel * -1);
      }

      cncserver.control.movePenAbs(point);

      i++;

      // Wiggle again!
      if (i <= iterations) {
        _wiggleSlave(!toggle);
      } else { // Done wiggling, go back to start
        control.movePenAbs(start);
      }
    }

    // Start the wiggle!
    _wiggleSlave(true);
  };

  // Exports...
  control.exports = {
    setTool: control.setTool,
    movePenAbs: control.movePenAbs,
  };

  return control;
};