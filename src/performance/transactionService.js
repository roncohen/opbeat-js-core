var Transaction = require('./transaction')
var utils = require('../lib/utils')
var Subscription = require('../common/subscription')

function TransactionService (zoneService, logger, config, opbeatBackend) {
  this._config = config
  if (typeof config === 'undefined') {
    logger.debug('TransactionService: config is not provided')
  }
  this._queue = []
  this._logger = logger
  this._opbeatBackend = opbeatBackend
  this._zoneService = zoneService

  this.transactions = []
  this.nextId = 1

  this.taskMap = {}

  this._queue = []

  this._subscription = new Subscription()

  var transactionService = this

  function onBeforeInvokeTask (task) {
    if (task.source === 'XMLHttpRequest.send' && task.trace && !task.trace.ended) {
      task.trace.end()
    }
    transactionService.logInTransaction('Executing', task.taskId)
  }
  zoneService.spec.onBeforeInvokeTask = onBeforeInvokeTask

  function onScheduleTask (task) {
    if (task.source === 'XMLHttpRequest.send') {
      var trace = transactionService.startTrace(task['XHR']['method'] + ' ' + task['XHR']['url'], 'ext.HttpRequest', {'enableStackFrames': false})
      task.trace = trace
    }
    transactionService.addTask(task.taskId)
  }
  zoneService.spec.onScheduleTask = onScheduleTask

  function onInvokeTask (task) {
    transactionService.removeTask(task.taskId)
    transactionService.detectFinish()
  }
  zoneService.spec.onInvokeTask = onInvokeTask

  function onCancelTask (task) {
    transactionService.removeTask(task.taskId)
    transactionService.detectFinish()
  }
  zoneService.spec.onCancelTask = onCancelTask
}

TransactionService.prototype.getTransaction = function (id) {
  return this.transactions[id]
}

TransactionService.prototype.createTransaction = function (name, type, options) {
  var tr = new Transaction(name, type, options)
  tr.contextInfo.debug.zone = this._zoneService.getCurrentZone().name
  this._zoneService.set('transaction', tr)
  if (this._config.get('performance.checkBrowserResponsiveness')) {
    this.startCounter(tr)
  }
  return tr
}

TransactionService.prototype.startCounter = function (transaction) {
  transaction.browserResponsivenessCounter = 0
  var interval = this._config.get('performance.browserResponsivenessInterval')
  if (typeof interval === 'undefined') {
    this._logger.debug('browserResponsivenessInterval is undefined!')
    return
  }
  this._zoneService.runOuter(function () {
    var id = setInterval(function () {
      if (transaction.ended) {
        window.clearInterval(id)
      } else {
        transaction.browserResponsivenessCounter++
      }
    }, interval)
  })
}

TransactionService.prototype.getCurrentTransaction = function () {
  var tr = this._zoneService.get('transaction')
  if (!utils.isUndefined(tr) && !tr.ended) {
    return tr
  }
}

TransactionService.prototype.startTransaction = function (name, type) {
  var self = this

  var perfOptions = this._config.get('performance')
  if (!perfOptions.enable || !this._zoneService.isOpbeatZone()) {
    return
  }

  if (type === 'interaction' && !perfOptions.captureInteractions) {
    return
  }

  var tr = this.getCurrentTransaction()

  if (tr) {
    if (tr.name !== 'ZoneTransaction') {
      // todo: need to handle cases in which the transaction has active traces and/or scheduled tasks
      this.logInTransaction('Ending early to start a new transaction:', name, type)
      this._logger.debug('Ending old transaction', tr)
      tr.end()
      tr = this.createTransaction(name, type, perfOptions)
    } else {
      tr.redefine(name, type, perfOptions)
    }
  } else {
    tr = this.createTransaction(name, type, perfOptions)
  }

  if (this.transactions.indexOf(tr) === -1) {
    this._logger.debug('TransactionService.startTransaction', tr)
    var p = tr.donePromise
    p.then(function (t) {
      self._logger.debug('TransactionService transaction finished', tr)
      self.add(tr)
      self._subscription.applyAll(self, [tr])

      var index = self.transactions.indexOf(tr)
      if (index !== -1) {
        self.transactions.splice(index, 1)
      }
    })
    this.transactions.push(tr)
  }

  return tr
}

TransactionService.prototype.startTrace = function (signature, type, options) {
  var perfOptions = this._config.get('performance')
  if (!perfOptions.enable || !this._zoneService.isOpbeatZone()) {
    return
  }

  var trans = this.getCurrentTransaction()

  if (trans) {
    this._logger.debug('TransactionService.startTrace', signature, type)
  } else {
    trans = this.createTransaction('ZoneTransaction', 'transaction', perfOptions)
    this._logger.debug('TransactionService.startTrace - ZoneTransaction', signature, type)
  }

  var trace = trans.startTrace(signature, type, options)
  // var zone = this._zoneService.getCurrentZone()
  // trace._zone = 'Zone(' + zone.$id + ') ' // parent(' + zone.parent.$id + ') '
  return trace
}

TransactionService.prototype.add = function (transaction) {
  var perfOptions = this._config.get('performance')
  if (!perfOptions.enable) {
    return
  }

  this._queue.push(transaction)
  this._logger.debug('TransactionService.add', transaction)
}

TransactionService.prototype.getTransactions = function () {
  return this._queue
}

TransactionService.prototype.clearTransactions = function () {
  this._queue = []
}

TransactionService.prototype.subscribe = function (fn) {
  return this._subscription.subscribe(fn)
}

TransactionService.prototype.addTask = function (taskId) {
  var tr = this._zoneService.get('transaction')
  if (!utils.isUndefined(tr) && !tr.ended) {
    tr.addTask(taskId)
    this._logger.debug('TransactionService.addTask', taskId)
  }
}
TransactionService.prototype.removeTask = function (taskId) {
  var tr = this._zoneService.get('transaction')
  if (!utils.isUndefined(tr) && !tr.ended) {
    tr.removeTask(taskId)
    this._logger.debug('TransactionService.removeTask', taskId)
  }
}
TransactionService.prototype.logInTransaction = function () {
  var tr = this._zoneService.get('transaction')
  if (!utils.isUndefined(tr) && !tr.ended) {
    tr.debugLog.apply(tr, arguments)
  }
}

TransactionService.prototype.detectFinish = function () {
  var tr = this._zoneService.get('transaction')
  if (!utils.isUndefined(tr) && !tr.ended) {
    tr.detectFinish()
    this._logger.debug('TransactionService.detectFinish')
  }
}

TransactionService.prototype.scheduleTransactionSend = function () {
  var logger = this._logger
  var opbeatBackend = this._opbeatBackend
  var self = this

  setInterval(function () {
    var transactions = self.getTransactions()
    if (transactions.length === 0) {
      return
    }
    logger.debug('Sending Transactions to opbeat.', transactions.length)
    // todo: if transactions are already being sent, should check
    opbeatBackend.sendTransactions(transactions)
    self.clearTransactions()
  }, 5000)
}

module.exports = TransactionService