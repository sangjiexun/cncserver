/**
 * @file CNC Server IPC runner. Handles outputting serial commands with the
 * correct timing, so the main thread can be as bogged down as it wants, this
 * process will remain untouched as long as there's a CPU to handle it.
 *
 * This is an entirely separated application that runs connected only via IPC
 * socket messages, always use the API to communicate, not this.
 */

// REQUIRES ====================================================================
const SerialPort = require('serialport');
const ipc = require('node-ipc');

// CONFIGURATION ===============================================================
ipc.config.id = 'cncrunner';
ipc.config.silent = true;
ipc.config.retry = 1000;
ipc.config.maxRetries = 10;

// RUNNER STATE ================================================================
let simulation = true; // Assume simulation mode by default.
let port = false; // The running port, once initiated.
let buffer = [];
let bufferRunning = false;
let bufferPaused = false;
let bufferExecuting = false;
let bufferDirectBusy = false;

// Runner config defaults, overridden on ready.
let config = {
  ack: 'OK',
  debug: false,
  showSerial: false,
};

const wrapper = {
  /**
   * Send an IPC message to the server.
   *
   * @param  {[type]} command
   *   Command name, in dot notation.
   * @param  {[type]} data
   *   Command data (optional).
   *
   * @return {null}
   */
  sendMessage: (command, data = {}) => {
    const packet = { command, data };

    ipc.of.cncserver.emit('app.message', packet);
  },
};

const serial = {
  // Serial disconnection callback
  /**
   * Callback event called on serial disconnect.
   *
   * @param {object} err
   *   Incoming data from serial port
   */
  disconnected: (err) => {
    console.log('Serial Disconnected!'.error + err.toString());
    wrapper.sendMessage('serial.disconnected', {
      type: 'disconnect',
      message: err.toString(),
    });
  },

  /**
   * Callback event called on connect to handle incoming data.
   *
   * @param {string} data
   *   Incoming data from serial port
   */
  readLine: (data) => {
    wrapper.sendMessage('serial.data', data.toString());
  },


  connect: (options) => {
    if (config.debug) console.log(`Connect to: ${JSON.stringify(options)}`);

    // Note: runner doesn't do autodetection.
    try {
      port = new SerialPort(options.port, options, (err) => {
        if (!err) {
          simulation = false;
          wrapper.sendMessage('serial.connected');
          console.log('CONNECTED TO ', options.port);

          const { Readline } = SerialPort.parsers;
          const parser = port.pipe(new Readline({ delimiter: '\r' }));
          parser.on('data', serial.readLine);
          port.on('disconnect', serial.disconnected);
          port.on('close', serial.disconnected);
        } else {
          simulation = true;
          if (config.debug) console.log(`SerialPort says: ${err.toString()}`);
          wrapper.sendMessage('serial.error', {
            type: 'connect',
            message: err.toString(),
          });
        }
      });
    } catch (err) {
      simulation = true;
      console.log(`SerialPort says: ${err.toString()}`);
      wrapper.sendMessage('serial.error', {
        type: 'connect',
        message: err.toString(),
      });
    }
  },

  /**
   * Write and drain a string to the connected serial port.
   *
   * @param  {string} command
   *   Command to write to the connected serial port, sans delimiter.
   * @param  {function} callback
   *   Callback when it should be sent/drained.
   */
  write: (command, callback) => {
    if (simulation) {
      if (config.showSerial) console.info(`Simulating serial write: ${command}`);
      setTimeout(() => {
        serial.readLine(config.ack);
        if (callback) callback();
      }, 1);
    } else {
      if (config.showSerial) console.info(`Executing serial write: ${command}`);
      if (config.debug) console.time('SerialSendtoDrain');
      try {
        // It should realistically never take longer than half a second to send.
        const writeTimeout = setTimeout(() => {
          console.error('WRITE TIMEOUT, COMMAND FAILED:', command);
        }, 500);

        port.write(`${command}\r`, 'ascii', () => {
          clearTimeout(writeTimeout);
          port.drain(() => {
            port.flush(() => {
              if (config.debug) console.timeEnd('SerialSendtoDrain');
              if (callback) callback();
            });
          });
        });
      } catch (e) {
        console.error('Failed to write to the serial port!:', e);
        wrapper.sendMessage('serial.error', { type: 'data', message: e });
        if (callback) callback(false);
      }
    }
  },
};


/**
 * Execute a set of commands representing a single buffer action item to write,
 * callback will be executed when fulley sent out to machine.
 *
 * @param {array} commands
 *  Array of regular/dynamic string commands to all be sent in order.
 *
 * @returns {boolean}
 *   True if success, false if failure
 */
function executeCommands(commands, callback, index = 0) {
  // Ensure commands is an array if only one sent.
  if (typeof commands === 'string') {
    // eslint-disable-next-line no-param-reassign
    commands = [commands];
  }

  // Run the command at the index.
  serial.write(commands[index], () => {
    // eslint-disable-next-line no-param-reassign
    index++; // Increment the index.

    // Now that the serial command has drained to the bot, run the next, or end?
    if (index < commands.length) {
      // Run the next one.
      executeCommands(commands, callback, index);
    } else {
      // End, no more commands left.
      // Timeout the next command send to avoid callstack addition.
      setTimeout(callback, 0);
    }
  });

  return true;
}

/**
 * Execute the next command in the buffer, triggered by self, buffer interval
 * catcher loop below.
 */
function executeNext() {
  // Don't continue execution if paused or already executing.
  if (bufferPaused || bufferExecuting) return;

  // Process a single line of the buffer =====================================
  if (buffer.length) {
    const item = buffer.pop();
    if (config.debug) console.log(`RUNNING ITEM: ${item.hash}`);
    wrapper.sendMessage('buffer.item.start', item.hash);
    bufferExecuting = true;

    // Some items don't have any rendered commands, only run those that do!
    if (item.commands.length) {
      executeCommands(item.commands, () => {
        if (config.debug) console.log(`ITEM DONE: ${item.hash}`);
        wrapper.sendMessage('buffer.item.done', item.hash);
        bufferExecuting = false;
        executeNext();
      });
    } else {
      // This buffer item doesn't have any serial commands, we're done here :)
      wrapper.sendMessage('buffer.item.done', item.hash);
      bufferExecuting = false;
      if (config.debug) console.log(`NO COMMANDS ITEM: ${item.hash}`);
      executeNext();
    }
  } else {
    wrapper.sendMessage('buffer.empty');
    // Buffer Empty.
    bufferRunning = false;
    bufferExecuting = false;
    wrapper.sendMessage('buffer.running', bufferRunning);
  }
}

// Buffer interval catcher, starts running as soon as items exist in the buffer.
setInterval(() => {
  if (buffer.length && !bufferRunning && !bufferPaused) {
    bufferRunning = true;
    wrapper.sendMessage('buffer.running', bufferRunning);
    executeNext();
  }
}, 10);

/**
 * IPC Message callback event parser/handler.
 *
 * @param  {object} packet
 *   The entire message object directly from the event.
 *
 * @return {null}
 */
function gotMessage(packet) {
  const { data } = packet;

  switch (packet.command) {
    case 'runner.config':
      config = data;
      if (config.debug) console.log('Config data:', JSON.stringify(config));
      break;
    case 'runner.shutdown':
      console.log('Recieved kill signal from host, shutting down runner.');
      process.exit(0);
      break;
    case 'serial.connect':
      serial.connect(data);
      break;
    case 'serial.direct.command':
      // Running a set of commands at exactly the same time as another with no
      // queue/buffer to manage it would be... a frightening mess.
      if (!bufferDirectBusy) {
        bufferDirectBusy = true;
        executeCommands(data.commands, () => {
          bufferDirectBusy = false;
        });
      }
      break;
    case 'serial.direct.write':
      serial.write(data);
      break;
    case 'buffer.add': // Add to the end of the buffer, last to be executed.
      // Buffer item data comes in in the following object format:
      //   hash {string}      : The tracking hash for this buffer item.
      //   commands {array}   : Array of rendered serial command strings.
      buffer.unshift(data);
      break;
    case 'buffer.pause': // Pause the running of the buffer.
      bufferPaused = true;
      console.log('BUFFER PAUSED');
      break;
    case 'buffer.resume': // Resume running of the buffer.
      bufferPaused = false;
      executeNext();
      console.log('BUFFER RESUMED');
      break;
    case 'buffer.clear': // Clear the entire buffer.
      buffer = [];
      if (simulation) {
        executeNext();
        console.log('BUFFER CLEARED');
      } else {
        port.flush(() => {
          executeNext();
          console.log('BUFFER CLEARED');
        });
      }
      break;
    default:
  }
}

// Catch any uncaught error.
process.on('uncaughtException', (err) => {
  // Assume Disconnection and kill the process.
  serial.disconnected(err);
  console.error('Uncaught error, disconnected from server, shutting down');
  console.error(err);
  process.exit(0);
});

// Actually initialize the IPC comms/server.
ipc.connectTo('cncserver', () => {
  ipc.of.cncserver.on('connect', () => {
    console.log('Connected to CNCServer!');
    wrapper.sendMessage('runner.ready');
  });

  ipc.of.cncserver.on('disconnect', () => {
    // ipc.log('Disconnected from server, shutting down'.notice);
    // process.exit(0);
  });

  ipc.of.cncserver.on('destroy', () => {
    console.log('All Retries failed or disconnected, shutting down');
    process.exit(0);
  });
  ipc.of.cncserver.on('app.message', gotMessage);
});