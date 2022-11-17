/*
 * (c) Copyright Ascensio System SIA 2010-2019
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA at 20A-12 Ernesta Birznieka-Upisha
 * street, Riga, Latvia, EU, LV-1050.
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * Pursuant to Section 7(b) of the License you must retain the original Product
 * logo when distributing the program. Pursuant to Section 7(e) we decline to
 * grant you any rights under trademark law for use of our trademarks.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

'use strict';
var os = require('os');
var path = require('path');
var fs = require('fs');
var url = require('url');
var childProcess = require('child_process');
var co = require('co');
var config = require('config');
var spawnAsync = require('@expo/spawn-async');
const bytes = require('bytes');
const lcid = require('lcid');
var configConverter = config.get('FileConverter.converter');

var commonDefines = require('./../../Common/sources/commondefines');
var storage = require('./../../Common/sources/storage-base');
var utils = require('./../../Common/sources/utils');
var logger = require('./../../Common/sources/logger');
var constants = require('./../../Common/sources/constants');
var baseConnector = require('./../../DocService/sources/baseConnector');
const wopiClient = require('./../../DocService/sources/wopiClient');
var statsDClient = require('./../../Common/sources/statsdclient');
var queueService = require('./../../Common/sources/taskqueueRabbitMQ');
const formatChecker = require('./../../Common/sources/formatchecker');
const operationContext = require('./../../Common/sources/operationContext');
const tenantManager = require('./../../Common/sources/tenantManager');

var cfgDownloadMaxBytes = configConverter.has('maxDownloadBytes') ? configConverter.get('maxDownloadBytes') : 100000000;
var cfgDownloadTimeout = configConverter.has('downloadTimeout') ? configConverter.get('downloadTimeout') : 60;
var cfgDownloadAttemptMaxCount = configConverter.has('downloadAttemptMaxCount') ? configConverter.get('downloadAttemptMaxCount') : 3;
var cfgDownloadAttemptDelay = configConverter.has('downloadAttemptDelay') ? configConverter.get('downloadAttemptDelay') : 1000;
var cfgFontDir = configConverter.get('fontDir');
var cfgPresentationThemesDir = configConverter.get('presentationThemesDir');
var cfgX2tPath = configConverter.get('x2tPath');
var cfgDocbuilderPath = configConverter.get('docbuilderPath');
var cfgArgs = configConverter.get('args');
var cfgSpawnOptions = configConverter.get('spawnOptions');
if (cfgSpawnOptions.env) {
  Object.assign(cfgSpawnOptions.env, process.env);
}
var cfgErrorFiles = configConverter.get('errorfiles');
var cfgInputLimits = configConverter.get('inputLimits');
const cfgStreamWriterBufferSize = configConverter.get('streamWriterBufferSize');
//cfgMaxRequestChanges was obtained as a result of the test: 84408 changes - 5,16 MB
const cfgMaxRequestChanges = config.get('services.CoAuthoring.server.maxRequestChanges');
const cfgForgottenFiles = config.get('services.CoAuthoring.server.forgottenfiles');
const cfgForgottenFilesName = config.get('services.CoAuthoring.server.forgottenfilesname');
const cfgNewFileTemplate = config.get('services.CoAuthoring.server.newFileTemplate');

//windows limit 512(2048) https://msdn.microsoft.com/en-us/library/6e3b887c.aspx
//Ubuntu 14.04 limit 4096 http://underyx.me/2015/05/18/raising-the-maximum-number-of-file-descriptors.html
//MacOs limit 2048 http://apple.stackexchange.com/questions/33715/too-many-open-files
var MAX_OPEN_FILES = 200;
var TEMP_PREFIX = 'ASC_CONVERT';
var queue = null;
var clientStatsD = statsDClient.getClient();
var exitCodesReturn = [constants.CONVERT_PARAMS, constants.CONVERT_NEED_PARAMS, constants.CONVERT_CORRUPTED,
  constants.CONVERT_DRM, constants.CONVERT_DRM_UNSUPPORTED, constants.CONVERT_PASSWORD, constants.CONVERT_LIMITS];
var exitCodesMinorError = [constants.CONVERT_NEED_PARAMS, constants.CONVERT_DRM, constants.CONVERT_DRM_UNSUPPORTED, constants.CONVERT_PASSWORD];
var exitCodesUpload = [constants.NO_ERROR, constants.CONVERT_CORRUPTED, constants.CONVERT_NEED_PARAMS,
  constants.CONVERT_DRM, constants.CONVERT_DRM_UNSUPPORTED];
let inputLimitsXmlCache;

function TaskQueueDataConvert(task) {
  var cmd = task.getCmd();
  this.key = cmd.savekey ? cmd.savekey : cmd.id;
  this.fileFrom = null;
  this.fileTo = null;
  this.title = cmd.getTitle();
  if(constants.AVS_OFFICESTUDIO_FILE_CROSSPLATFORM_PDFA !== cmd.getOutputFormat()){
    this.formatTo = cmd.getOutputFormat();
  } else {
    this.formatTo = constants.AVS_OFFICESTUDIO_FILE_CROSSPLATFORM_PDF;
    this.isPDFA = true;
  }
  this.csvTxtEncoding = cmd.getCodepage();
  this.csvDelimiter = cmd.getDelimiter();
  this.csvDelimiterChar = cmd.getDelimiterChar();
  this.paid = task.getPaid();
  this.embeddedFonts = cmd.embeddedfonts;
  this.fromChanges = task.getFromChanges();
  //todo
  if (cfgFontDir) {
    this.fontDir = path.resolve(cfgFontDir);
  } else {
    this.fontDir = cfgFontDir;
  }
  this.themeDir = path.resolve(cfgPresentationThemesDir);
  this.mailMergeSend = cmd.mailmergesend;
  this.thumbnail = cmd.thumbnail;
  this.textParams = cmd.getTextParams();
  this.jsonParams = cmd.getJsonParams();
  this.lcid = cmd.getLCID();
  this.password = cmd.getPassword();
  this.savePassword = cmd.getSavePassword();
  this.noBase64 = cmd.getNoBase64();
  this.convertToOrigin = cmd.getConvertToOrigin();
  this.timestamp = new Date();
}
TaskQueueDataConvert.prototype = {
  serialize: function(fsPath) {
    let xml = '\ufeff<?xml version="1.0" encoding="utf-8"?>';
    xml += '<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
    xml += ' xmlns:xsd="http://www.w3.org/2001/XMLSchema">';
    xml += this.serializeXmlProp('m_sKey', this.key);
    xml += this.serializeXmlProp('m_sFileFrom', this.fileFrom);
    xml += this.serializeXmlProp('m_sFileTo', this.fileTo);
    xml += this.serializeXmlProp('m_sTitle', this.title);
    xml += this.serializeXmlProp('m_nFormatTo', this.formatTo);
    xml += this.serializeXmlProp('m_bIsPDFA', this.isPDFA);
    xml += this.serializeXmlProp('m_nCsvTxtEncoding', this.csvTxtEncoding);
    xml += this.serializeXmlProp('m_nCsvDelimiter', this.csvDelimiter);
    xml += this.serializeXmlProp('m_nCsvDelimiterChar', this.csvDelimiterChar);
    xml += this.serializeXmlProp('m_bPaid', this.paid);
    xml += this.serializeXmlProp('m_bEmbeddedFonts', this.embeddedFonts);
    xml += this.serializeXmlProp('m_bFromChanges', this.fromChanges);
    xml += this.serializeXmlProp('m_sFontDir', this.fontDir);
    xml += this.serializeXmlProp('m_sThemeDir', this.themeDir);
    if (this.mailMergeSend) {
      xml += this.serializeMailMerge(this.mailMergeSend);
    }
    if (this.thumbnail) {
      xml += this.serializeThumbnail(this.thumbnail);
    }
    if (this.textParams) {
      xml += this.serializeTextParams(this.textParams);
    }
    xml += this.serializeXmlProp('m_sJsonParams', this.jsonParams);
    xml += this.serializeXmlProp('m_nLcid', this.lcid);
    xml += this.serializeXmlProp('m_oTimestamp', this.timestamp.toISOString());
    xml += this.serializeXmlProp('m_bIsNoBase64', this.noBase64);
    xml += this.serializeXmlProp('m_sConvertToOrigin', this.convertToOrigin);
    xml += this.serializeLimit();
    xml += '</TaskQueueDataConvert>';
    fs.writeFileSync(fsPath, xml, {encoding: 'utf8'});
  },
  serializeHidden: function() {
    var t = this;
    return co(function* () {
      let xml;
      if (t.password || t.savePassword) {
        xml = '<TaskQueueDataConvert>';
        if(t.password) {
          let password = yield utils.decryptPassword(t.password);
          xml += t.serializeXmlProp('m_sPassword', password);
        }
        if(t.savePassword) {
          let savePassword = yield utils.decryptPassword(t.savePassword);
          xml += t.serializeXmlProp('m_sSavePassword', savePassword);
        }
        xml += '</TaskQueueDataConvert>';
      }
      return xml;
    });
  },
  serializeMailMerge: function(data) {
    var xml = '<m_oMailMergeSend>';
    xml += this.serializeXmlProp('from', data.getFrom());
    xml += this.serializeXmlProp('to', data.getTo());
    xml += this.serializeXmlProp('subject', data.getSubject());
    xml += this.serializeXmlProp('mailFormat', data.getMailFormat());
    xml += this.serializeXmlProp('fileName', data.getFileName());
    xml += this.serializeXmlProp('message', data.getMessage());
    xml += this.serializeXmlProp('recordFrom', data.getRecordFrom());
    xml += this.serializeXmlProp('recordTo', data.getRecordTo());
    xml += this.serializeXmlProp('recordCount', data.getRecordCount());
    xml += this.serializeXmlProp('userid', data.getUserId());
    xml += this.serializeXmlProp('url', data.getUrl());
    xml += '</m_oMailMergeSend>';
    return xml;
  },
  serializeThumbnail: function(data) {
    var xml = '<m_oThumbnail>';
    xml += this.serializeXmlProp('format', data.getFormat());
    xml += this.serializeXmlProp('aspect', data.getAspect());
    xml += this.serializeXmlProp('first', data.getFirst());
    xml += this.serializeXmlProp('width', data.getWidth());
    xml += this.serializeXmlProp('height', data.getHeight());
    xml += '</m_oThumbnail>';
    return xml;
  },
  serializeTextParams: function(data) {
    var xml = '<m_oTextParams>';
    xml += this.serializeXmlProp('m_nTextAssociationType', data.getAssociation());
    xml += '</m_oTextParams>';
    return xml;
  },
  serializeLimit: function() {
    if (!inputLimitsXmlCache) {
      var xml = '<m_oInputLimits>';
      for (let i = 0; i < cfgInputLimits.length; ++i) {
        let limit = cfgInputLimits[i];
        if (limit.type && limit.zip) {
          xml += '<m_oInputLimit';
          xml += this.serializeXmlAttr('type', limit.type);
          xml += '>';
          xml += '<m_oZip';
          if (limit.zip.compressed) {
            xml += this.serializeXmlAttr('compressed', bytes.parse(limit.zip.compressed));
          }
          if (limit.zip.uncompressed) {
            xml += this.serializeXmlAttr('uncompressed', bytes.parse(limit.zip.uncompressed));
          }
          xml += this.serializeXmlAttr('template', limit.zip.template);
          xml += '/>';
          xml += '</m_oInputLimit>';
        }
      }
      xml += '</m_oInputLimits>';
      inputLimitsXmlCache = xml;
    }
    return inputLimitsXmlCache;
  },
  serializeXmlProp: function(name, value) {
    var xml = '';
    if (null != value) {
      xml += '<' + name + '>';
      xml += utils.encodeXml(value.toString());
      xml += '</' + name + '>';
    } else {
      xml += '<' + name + ' xsi:nil="true" />';
    }
    return xml;
  },
  serializeXmlAttr: function(name, value) {
    var xml = '';
    if (null != value) {
      xml += ' ' + name + '=\"';
      xml += utils.encodeXml(value.toString());
      xml += '\"';
    }
    return xml;
  }
};

function getTempDir() {
  var tempDir = os.tmpdir();
  var now = new Date();
  var newTemp;
  while (!newTemp || fs.existsSync(newTemp)) {
    var newName = [TEMP_PREFIX, now.getYear(), now.getMonth(), now.getDate(),
      '-', (Math.random() * 0x100000000 + 1).toString(36)
    ].join('');
    newTemp = path.join(tempDir, newName);
  }
  fs.mkdirSync(newTemp);
  var sourceDir = path.join(newTemp, 'source');
  fs.mkdirSync(sourceDir);
  var resultDir = path.join(newTemp, 'result');
  fs.mkdirSync(resultDir);
  return {temp: newTemp, source: sourceDir, result: resultDir};
}
function* replaceEmptyFile(ctx, fileFrom, ext, _lcid) {
  if (!fs.existsSync(fileFrom) ||  0 === fs.lstatSync(fileFrom).size) {
    let locale = 'en-US';
    if (_lcid) {
      let localeNew = lcid.from(_lcid);
      if (localeNew) {
        localeNew = localeNew.replace(/_/g, '-');
        if (fs.existsSync(path.join(cfgNewFileTemplate, localeNew))) {
          locale = localeNew;
        } else {
          ctx.logger.debug('replaceEmptyFile empty locale dir locale=%s', localeNew);
        }
      }
    }
    ctx.logger.debug('replaceEmptyFile format=%s locale=%s', ext, locale);
    let format = formatChecker.getFormatFromString(ext);
    if (formatChecker.isDocumentFormat(format)) {
      fs.copyFileSync(path.join(cfgNewFileTemplate, locale, 'new.docx'), fileFrom);
    } else if (formatChecker.isSpreadsheetFormat(format)) {
      fs.copyFileSync(path.join(cfgNewFileTemplate, locale, 'new.xlsx'), fileFrom);
    } else if (formatChecker.isPresentationFormat(format)) {
      fs.copyFileSync(path.join(cfgNewFileTemplate, locale, 'new.pptx'), fileFrom);
    }
  }
}
function* downloadFile(ctx, uri, fileFrom, withAuthorization, filterPrivate, opt_headers) {
  var res = constants.CONVERT_DOWNLOAD;
  var data = null;
  var downloadAttemptCount = 0;
  var urlParsed = url.parse(uri);
  var filterStatus = yield* utils.checkHostFilter(ctx, urlParsed.hostname);
  if (0 == filterStatus) {
    while (constants.NO_ERROR !== res && downloadAttemptCount++ < cfgDownloadAttemptMaxCount) {
      try {
        let authorization;
        if (utils.canIncludeOutboxAuthorization(ctx, uri) && withAuthorization) {
          let secret = yield tenantManager.getTenantSecret(ctx, commonDefines.c_oAscSecretType.Outbox);
          authorization = utils.fillJwtForRequest({url: uri}, secret, false);
        }
        let getRes = yield utils.downloadUrlPromise(ctx, uri, cfgDownloadTimeout, cfgDownloadMaxBytes, authorization, filterPrivate, opt_headers);
        data = getRes.body;
        res = constants.NO_ERROR;
      } catch (err) {
        res = constants.CONVERT_DOWNLOAD;
        ctx.logger.error('error downloadFile:url=%s;attempt=%d;code:%s;connect:%s %s', uri, downloadAttemptCount, err.code, err.connect, err.stack);
        //not continue attempts if timeout
        if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
          break;
        } else if (err.code === 'EMSGSIZE') {
          res = constants.CONVERT_LIMITS;
          break;
        } else {
          yield utils.sleep(cfgDownloadAttemptDelay);
        }
      }
    }
    if (constants.NO_ERROR === res) {
      ctx.logger.debug('downloadFile complete filesize=%d', data.length);
      fs.writeFileSync(fileFrom, data);
    }
  } else {
    ctx.logger.error('checkIpFilter error:url=%s;code:%s;', uri, filterStatus);
    res = constants.CONVERT_DOWNLOAD;
  }
  return res;
}
function* downloadFileFromStorage(ctx, strPath, dir, opt_specialDir) {
  var list = yield storage.listObjects(ctx, strPath, opt_specialDir);
  ctx.logger.debug('downloadFileFromStorage list %s', list.toString());
  //create dirs
  var dirsToCreate = [];
  var dirStruct = {};
  list.forEach(function(file) {
    var curDirPath = dir;
    var curDirStruct = dirStruct;
    var parts = storage.getRelativePath(strPath, file).split('/');
    for (var i = 0; i < parts.length - 1; ++i) {
      var part = parts[i];
      curDirPath = path.join(curDirPath, part);
      if (!curDirStruct[part]) {
        curDirStruct[part] = {};
        dirsToCreate.push(curDirPath);
      }
    }
  });
  //make dirs
  for (var i = 0; i < dirsToCreate.length; ++i) {
    fs.mkdirSync(dirsToCreate[i]);
  }
  //download
  //todo Promise.all
  for (var i = 0; i < list.length; ++i) {
    var file = list[i];
    var fileRel = storage.getRelativePath(strPath, file);
    var data = yield storage.getObject(ctx, file, opt_specialDir);
    fs.writeFileSync(path.join(dir, fileRel), data);
  }
}
function* processDownloadFromStorage(ctx, dataConvert, cmd, task, tempDirs, authorProps) {
  let res = constants.NO_ERROR;
  let needConcatFiles = false;
  if (task.getFromOrigin() || task.getFromSettings()) {
    dataConvert.fileFrom = path.join(tempDirs.source, 'origin.' + cmd.getFormat());
  } else {
    //перезаписываем некоторые файлы из m_sKey(например Editor.bin или changes)
    yield* downloadFileFromStorage(ctx, cmd.getSaveKey(), tempDirs.source);
    let format = cmd.getFormat() || 'bin';
    dataConvert.fileFrom = path.join(tempDirs.source, 'Editor.' + format);
    needConcatFiles = true;
  }
  if (!utils.checkPathTraversal(ctx, dataConvert.key, tempDirs.source, dataConvert.fileFrom)) {
    return constants.CONVERT_PARAMS;
  }
  //mail merge
  let mailMergeSend = cmd.getMailMergeSend();
  if (mailMergeSend) {
    yield* downloadFileFromStorage(ctx, mailMergeSend.getJsonKey(), tempDirs.source);
    needConcatFiles = true;
  }
  if (needConcatFiles) {
    yield* concatFiles(tempDirs.source);
  }
  if (task.getFromChanges()) {
    res = yield* processChanges(ctx, tempDirs, cmd, authorProps);
  }
  //todo rework
  if (!fs.existsSync(dataConvert.fileFrom)) {
    if (fs.existsSync(path.join(tempDirs.source, 'origin.docx'))) {
      dataConvert.fileFrom = path.join(tempDirs.source, 'origin.docx');
    } else if (fs.existsSync(path.join(tempDirs.source, 'origin.xlsx'))) {
      dataConvert.fileFrom = path.join(tempDirs.source, 'origin.xlsx');
    } else if (fs.existsSync(path.join(tempDirs.source, 'origin.pptx'))) {
      dataConvert.fileFrom = path.join(tempDirs.source, 'origin.pptx');
    }
    let fileFromNew = path.join(path.dirname(dataConvert.fileFrom), "Editor.bin");
    fs.renameSync(dataConvert.fileFrom, fileFromNew);
    dataConvert.fileFrom = fileFromNew;
  }
  return res;
}

function* concatFiles(source) {
  //concatenate EditorN.ext parts in Editor.ext
  let list = yield utils.listObjects(source, true);
  list.sort(utils.compareStringByLength);
  let writeStreams = {};
  for (let i = 0; i < list.length; ++i) {
    let file = list[i];
    if (file.match(/Editor\d+\./)) {
      let target = file.replace(/(Editor)\d+(\..*)/, '$1$2');
      let writeStream = writeStreams[target];
      if (!writeStream) {
        writeStream = yield utils.promiseCreateWriteStream(target);
        writeStreams[target] = writeStream;
      }
      let readStream = yield utils.promiseCreateReadStream(file);
      yield utils.pipeStreams(readStream, writeStream, false);
    }
  }
  for (let i in writeStreams) {
    if (writeStreams.hasOwnProperty(i)) {
      writeStreams[i].end();
    }
  }
}

function* processChanges(ctx, tempDirs, cmd, authorProps) {
  let res = constants.NO_ERROR;
  let changesDir = path.join(tempDirs.source, constants.CHANGES_NAME);
  fs.mkdirSync(changesDir);
  let indexFile = 0;
  let changesAuthor = null;
  let changesAuthorUnique = null;
  let changesIndex = null;
  let changesHistory = {
    serverVersion: commonDefines.buildVersion,
    changes: []
  };
  let forceSave = cmd.getForceSave();
  let forceSaveTime;
  let forceSaveIndex = Number.MAX_VALUE;
  if (forceSave && undefined !== forceSave.getTime() && undefined !== forceSave.getIndex()) {
    forceSaveTime = forceSave.getTime();
    forceSaveIndex = forceSave.getIndex();
  }
  let extChangeInfo = cmd.getExternalChangeInfo();
  let extChanges;
  if (extChangeInfo) {
    extChanges = [{
      id: cmd.getDocId(), change_id: 0, change_data: "", user_id: extChangeInfo.user_id,
      user_id_original: extChangeInfo.user_id_original, user_name: extChangeInfo.user_name,
      change_date: new Date(extChangeInfo.change_date)
    }];
  }

  let streamObj = yield* streamCreate(ctx, changesDir, indexFile++, {highWaterMark: cfgStreamWriterBufferSize});
  let curIndexStart = 0;
  let curIndexEnd = Math.min(curIndexStart + cfgMaxRequestChanges, forceSaveIndex);
  while (curIndexStart < curIndexEnd || extChanges) {
    let changes = [];
    if (curIndexStart < curIndexEnd) {
      changes = yield baseConnector.getChangesPromise(ctx, cmd.getDocId(), curIndexStart, curIndexEnd, forceSaveTime);
    }
    if (0 === changes.length && extChanges) {
      changes = extChanges;
    }
    extChanges = undefined;
    for (let i = 0; i < changes.length; ++i) {
      let change = changes[i];
      if (change.change_data.startsWith('ENCRYPTED;')) {
        ctx.logger.warn('processChanges encrypted changes');
        //todo sql request instead?
        res = constants.EDITOR_CHANGES;
        break;
      }
      if (null === changesAuthor || changesAuthor !== change.user_id_original) {
        if (null !== changesAuthor) {
          yield* streamEnd(streamObj, ']');
          streamObj = yield* streamCreate(ctx, changesDir, indexFile++);
        }
        let strDate = baseConnector.getDateTime(change.change_date);
        changesHistory.changes.push({'created': strDate, 'user': {'id': change.user_id_original, 'name': change.user_name}});
        yield* streamWrite(streamObj, '[');
      } else {
        yield* streamWrite(streamObj, ',');
      }
      changesAuthor = change.user_id_original;
      changesAuthorUnique = change.user_id;
      yield* streamWrite(streamObj, change.change_data);
      streamObj.isNoChangesInFile = false;
    }
    if (changes.length > 0) {
      authorProps.lastModifiedBy = changes[changes.length - 1].user_name;
      authorProps.modified = changes[changes.length - 1].change_date.toISOString().slice(0, 19) + 'Z';
    }
    if (changes.length === curIndexEnd - curIndexStart) {
      curIndexStart += cfgMaxRequestChanges;
      curIndexEnd = Math.min(curIndexStart + cfgMaxRequestChanges, forceSaveIndex);
    } else {
      break;
    }
  }
  yield* streamEnd(streamObj, ']');
  if (streamObj.isNoChangesInFile) {
    fs.unlinkSync(streamObj.filePath);
  }
  if (null !== changesAuthorUnique) {
    changesIndex = utils.getIndexFromUserId(changesAuthorUnique, changesAuthor);
  }
  if (null == changesAuthor && null == changesIndex && forceSave && undefined !== forceSave.getAuthorUserId() &&
    undefined !== forceSave.getAuthorUserIndex()) {
    changesAuthor = forceSave.getAuthorUserId();
    changesIndex = forceSave.getAuthorUserIndex();
  }
  cmd.setUserId(changesAuthor);
  cmd.setUserIndex(changesIndex);
  fs.writeFileSync(path.join(tempDirs.result, 'changesHistory.json'), JSON.stringify(changesHistory), 'utf8');
  ctx.logger.debug('processChanges end');
  return res;
}

function* streamCreate(ctx, changesDir, indexFile, opt_options) {
  let fileName = constants.CHANGES_NAME + indexFile + '.json';
  let filePath = path.join(changesDir, fileName);
  let writeStream = yield utils.promiseCreateWriteStream(filePath, opt_options);
  writeStream.on('error', function(err) {
    //todo integrate error handle in main thread (probable: set flag here and check it in main thread)
    ctx.logger.error('WriteStreamError %s', err.stack);
  });
  return {writeStream: writeStream, filePath: filePath, isNoChangesInFile: true};
}

function* streamWrite(streamObj, text) {
  if (!streamObj.writeStream.write(text, 'utf8')) {
    yield utils.promiseWaitDrain(streamObj.writeStream);
  }
}

function* streamEnd(streamObj, text) {
  streamObj.writeStream.end(text, 'utf8');
  yield utils.promiseWaitClose(streamObj.writeStream);
}
function* processUploadToStorage(ctx, dir, storagePath) {
  var list = yield utils.listObjects(dir);
  if (list.length < MAX_OPEN_FILES) {
    yield* processUploadToStorageChunk(ctx, list, dir, storagePath);
  } else {
    for (var i = 0, j = list.length; i < j; i += MAX_OPEN_FILES) {
      yield* processUploadToStorageChunk(ctx, list.slice(i, i + MAX_OPEN_FILES), dir, storagePath);
    }
  }
}
function* processUploadToStorageChunk(ctx, list, dir, storagePath) {
  yield Promise.all(list.map(function (curValue) {
    let localValue = storagePath + '/' + curValue.substring(dir.length + 1);
    return storage.uploadObject(ctx, localValue, curValue);
  }));
}
function writeProcessOutputToLog(ctx, childRes, isDebug) {
  if (childRes) {
    if (undefined !== childRes.stdout) {
      if (isDebug) {
        ctx.logger.debug('stdout:%s', childRes.stdout);
      } else {
        ctx.logger.error('stdout:%s', childRes.stdout);
      }
    }
    if (undefined !== childRes.stderr) {
      if (isDebug) {
        ctx.logger.debug('stderr:%s', childRes.stderr);
      } else {
        ctx.logger.error('stderr:%s', childRes.stderr);
      }
    }
  }
}
function* postProcess(ctx, cmd, dataConvert, tempDirs, childRes, error, isTimeout) {
  var exitCode = 0;
  var exitSignal = null;
  if(childRes) {
    exitCode = childRes.status;
    exitSignal = childRes.signal;
  }
  if (0 !== exitCode || null !== exitSignal) {
    if (-1 !== exitCodesReturn.indexOf(-exitCode)) {
      error = -exitCode;
    } else if(isTimeout) {
      error = constants.CONVERT_TIMEOUT;
    } else {
      error = constants.CONVERT;
    }
    if (-1 !== exitCodesMinorError.indexOf(error)) {
      writeProcessOutputToLog(ctx, childRes, true);
      ctx.logger.debug('ExitCode (code=%d;signal=%s;error:%d)', exitCode, exitSignal, error);
    } else {
      writeProcessOutputToLog(ctx, childRes, false);
      ctx.logger.error('ExitCode (code=%d;signal=%s;error:%d)', exitCode, exitSignal, error);
      if (cfgErrorFiles) {
        yield* processUploadToStorage(ctx, tempDirs.temp, dataConvert.key, cfgErrorFiles);
        ctx.logger.debug('processUploadToStorage error complete(id=%s)', dataConvert.key);
      }
    }
  } else {
    writeProcessOutputToLog(ctx, childRes, true);
    ctx.logger.debug('ExitCode (code=%d;signal=%s;error:%d)', exitCode, exitSignal, error);
  }
  if (-1 !== exitCodesUpload.indexOf(error)) {
    yield* processUploadToStorage(ctx, tempDirs.result, dataConvert.key);
    ctx.logger.debug('processUploadToStorage complete');
  }
  cmd.setStatusInfo(error);
  var existFile = false;
  try {
    existFile = fs.lstatSync(dataConvert.fileTo).isFile();
  } catch (err) {
    existFile = false;
  }
  if (!existFile) {
    //todo пересмотреть. загрулка в случае AVS_OFFICESTUDIO_FILE_OTHER_OOXML x2t меняет расширение у файла.
    var fileToBasename = path.basename(dataConvert.fileTo, path.extname(dataConvert.fileTo));
    var fileToDir = path.dirname(dataConvert.fileTo);
    var files = fs.readdirSync(fileToDir);
    for (var i = 0; i < files.length; ++i) {
      var fileCur = files[i];
      if (0 == fileCur.indexOf(fileToBasename)) {
        dataConvert.fileTo = path.join(fileToDir, fileCur);
        break;
      }
    }
  }
  cmd.setOutputPath(path.basename(dataConvert.fileTo));
  if(!cmd.getTitle()){
    cmd.setTitle(cmd.getOutputPath());
  }

  var queueData = new commonDefines.TaskQueueData();
  queueData.setCtx(ctx);
  queueData.setCmd(cmd);
  ctx.logger.debug('output (data=%j)', queueData);
  return queueData;
}

function* spawnProcess(ctx, isBuilder, tempDirs, dataConvert, authorProps, getTaskTime, task) {
  let childRes, isTimeout = false;
  let childArgs;
  if (cfgArgs.length > 0) {
    childArgs = cfgArgs.trim().replace(/  +/g, ' ').split(' ');
  } else {
    childArgs = [];
  }
  let processPath;
  if (!isBuilder) {
    processPath = cfgX2tPath;
    let paramsFile = path.join(tempDirs.temp, 'params.xml');
    dataConvert.serialize(paramsFile);
    childArgs.push(paramsFile);
    let hiddenXml = yield dataConvert.serializeHidden();
    if (hiddenXml) {
      childArgs.push(hiddenXml);
    }
  } else {
    fs.mkdirSync(path.join(tempDirs.result, 'output'));
    processPath = cfgDocbuilderPath;
    childArgs.push('--check-fonts=0');
    childArgs.push('--save-use-only-names=' + tempDirs.result + '/output');
    childArgs.push(dataConvert.fileFrom);
  }
  let timeoutId;
  try {
    let spawnOptions = cfgSpawnOptions;
    if (authorProps.lastModifiedBy && authorProps.modified) {
      //copy to avoid modification of global cfgSpawnOptions
      spawnOptions = Object.assign({}, cfgSpawnOptions);
      spawnOptions.env = Object.assign({}, spawnOptions.env || process.env);

      spawnOptions.env['LAST_MODIFIED_BY'] = authorProps.lastModifiedBy;
      spawnOptions.env['MODIFIED'] = authorProps.modified;
    }
    let spawnAsyncPromise = spawnAsync(processPath, childArgs, spawnOptions);
    childRes = spawnAsyncPromise.child;
    let waitMS = task.getVisibilityTimeout() * 1000 - (new Date().getTime() - getTaskTime.getTime());
    timeoutId = setTimeout(function() {
      isTimeout = true;
      timeoutId = undefined;
      //close stdio streams to enable emit 'close' event even if HtmlFileInternal is hung-up
      childRes.stdin.end();
      childRes.stdout.destroy();
      childRes.stderr.destroy();
      childRes.kill();
    }, waitMS);
    childRes = yield spawnAsyncPromise;
  } catch (err) {
    if (null === err.status) {
      ctx.logger.error('error spawnAsync %s', err.stack);
    } else {
      ctx.logger.debug('error spawnAsync %s', err.stack);
    }
    childRes = err;
  }
  if (undefined !== timeoutId) {
    clearTimeout(timeoutId);
  }
  return {childRes: childRes, isTimeout: isTimeout};
}

function* ExecuteTask(ctx, task) {
  var startDate = null;
  var curDate = null;
  if(clientStatsD) {
    startDate = curDate = new Date();
  }
  var resData;
  var tempDirs;
  var getTaskTime = new Date();
  var cmd = task.getCmd();
  var dataConvert = new TaskQueueDataConvert(task);
  ctx.logger.info('Start Task');
  var error = constants.NO_ERROR;
  tempDirs = getTempDir();
  let fileTo = task.getToFile();
  dataConvert.fileTo = fileTo ? path.join(tempDirs.result, fileTo) : '';
  let isBuilder = cmd.getIsBuilder();
  let authorProps = {lastModifiedBy: null, modified: null};
  if (cmd.getUrl()) {
    let format = cmd.getFormat();
    dataConvert.fileFrom = path.join(tempDirs.source, dataConvert.key + '.' + format);
    if (utils.checkPathTraversal(ctx, dataConvert.key, tempDirs.source, dataConvert.fileFrom)) {
      let url = cmd.getUrl();
      let withAuthorization = cmd.getWithAuthorization();
      let filterPrivate = !withAuthorization;
      let headers;
      let fileSize;
      let wopiParams = cmd.getWopiParams();
      if (wopiParams) {
        withAuthorization = false;
        filterPrivate = false;
        let fileInfo = wopiParams.commonInfo.fileInfo;
        let userAuth = wopiParams.userAuth;
        fileSize = fileInfo.Size;
        if (fileInfo.FileUrl) {
          url = fileInfo.FileUrl;
        } else if (fileInfo.TemplateSource) {
          url = fileInfo.TemplateSource;
        } else if (userAuth) {
          url = `${userAuth.wopiSrc}/contents?access_token=${userAuth.access_token}`;
          headers = {'X-WOPI-MaxExpectedSize': cfgDownloadMaxBytes, 'X-WOPI-ItemVersion': fileInfo.Version};
          wopiClient.fillStandardHeaders(headers, url, userAuth.access_token);
        }
        ctx.logger.debug('wopi url=%s; headers=%j', url, headers);
      }
      if (undefined === fileSize || fileSize > 0) {
        error = yield* downloadFile(ctx, url, dataConvert.fileFrom, withAuthorization, filterPrivate, headers);
      }
      if (constants.NO_ERROR === error) {
        yield* replaceEmptyFile(ctx, dataConvert.fileFrom, format, cmd.getLCID());
      }
      if(clientStatsD) {
        clientStatsD.timing('conv.downloadFile', new Date() - curDate);
        curDate = new Date();
      }
    } else {
      error = constants.CONVERT_PARAMS;
    }
  } else if (cmd.getSaveKey()) {
    yield* downloadFileFromStorage(ctx, cmd.getDocId(), tempDirs.source);
    ctx.logger.debug('downloadFileFromStorage complete');
    if(clientStatsD) {
      clientStatsD.timing('conv.downloadFileFromStorage', new Date() - curDate);
      curDate = new Date();
    }
    error = yield* processDownloadFromStorage(ctx, dataConvert, cmd, task, tempDirs, authorProps);
  } else if (cmd.getForgotten()) {
    yield* downloadFileFromStorage(ctx, cmd.getForgotten(), tempDirs.source, cfgForgottenFiles);
    ctx.logger.debug('downloadFileFromStorage complete');
    let list = yield utils.listObjects(tempDirs.source, false);
    if (list.length > 0) {
      dataConvert.fileFrom = list[0];
      //store indicator file to determine if opening was from the forgotten file
      var forgottenMarkPath = tempDirs.result + '/' + cfgForgottenFilesName + '.txt';
      fs.writeFileSync(forgottenMarkPath, cfgForgottenFilesName, {encoding: 'utf8'});
    } else {
      error = constants.UNKNOWN;
    }
  } else if (isBuilder) {
    //in cause script in POST body
    yield* downloadFileFromStorage(ctx, cmd.getDocId(), tempDirs.source);
    ctx.logger.debug('downloadFileFromStorage complete');
    let list = yield utils.listObjects(tempDirs.source, false);
    if (list.length > 0) {
      dataConvert.fileFrom = list[0];
    }
  } else {
    error = constants.UNKNOWN;
  }
  let childRes = null;
  let isTimeout = false;
  if (constants.NO_ERROR === error) {
    ({childRes, isTimeout} = yield* spawnProcess(ctx, isBuilder, tempDirs, dataConvert, authorProps, getTaskTime, task));
    if (childRes && 0 !== childRes.status && !isTimeout && task.getFromChanges()
      && constants.AVS_OFFICESTUDIO_FILE_OTHER_OOXML !== dataConvert.formatTo
      && !formatChecker.isOOXFormat(dataConvert.formatTo) && !cmd.getWopiParams()) {
      ctx.logger.warn('rollback to save changes to ooxml. See assemblyFormatAsOrigin param. formatTo=%s', formatChecker.getStringFromFormat(dataConvert.formatTo));
      let extOld = path.extname(dataConvert.fileTo);
      let extNew = '.' + formatChecker.getStringFromFormat(constants.AVS_OFFICESTUDIO_FILE_OTHER_OOXML);
      dataConvert.formatTo = constants.AVS_OFFICESTUDIO_FILE_OTHER_OOXML;
      dataConvert.fileTo = dataConvert.fileTo.slice(0, -extOld.length) + extNew;
      ({childRes, isTimeout} = yield* spawnProcess(ctx, isBuilder, tempDirs, dataConvert, authorProps, getTaskTime, task));
    }
    if(clientStatsD) {
      clientStatsD.timing('conv.spawnSync', new Date() - curDate);
      curDate = new Date();
    }
  }
  resData = yield* postProcess(ctx, cmd, dataConvert, tempDirs, childRes, error, isTimeout);
  ctx.logger.debug('postProcess');
  if(clientStatsD) {
    clientStatsD.timing('conv.postProcess', new Date() - curDate);
    curDate = new Date();
  }
  if (tempDirs) {
    fs.rmSync(tempDirs.temp, { recursive: true, force: true });
    ctx.logger.debug('deleteFolderRecursive');
    if(clientStatsD) {
      clientStatsD.timing('conv.deleteFolderRecursive', new Date() - curDate);
      curDate = new Date();
    }
  }
  if(clientStatsD) {
    clientStatsD.timing('conv.allconvert', new Date() - startDate);
  }
  ctx.logger.info('End Task');
  return resData;
}
function ackTask(ctx, res, task, ack) {
  return co(function*() {
    try {
      if (!res) {
        res = createErrorResponse(ctx, task);
      }
      if (res) {
        yield queue.addResponse(res);
        ctx.logger.info('ackTask addResponse');
      }
    } catch (err) {
      ctx.logger.error('ackTask %s', err.stack);
    } finally {
      ack();
      ctx.logger.info('ackTask ack');
    }
  });
}
function receiveTaskSetTimeout(ctx, task, ack, outParams) {
  let delay = 1.1 * task.getVisibilityTimeout() * 1000;
  return setTimeout(function() {
    return co(function*() {
      outParams.isAck = true;
      ctx.logger.error('receiveTask timeout %d', delay);
      yield ackTask(ctx, null, task, ack);
      yield queue.closeOrWait();
      process.exit(1);
    });
  }, delay);
}
function receiveTask(data, ack) {
  return co(function* () {
    var res = null;
    var task = null;
    let outParams = {isAck: false};
    let timeoutId = undefined;
    let ctx = new operationContext.Context();
    try {
      var payload = JSON.parse(data);
      if (payload.sessionData != null) {
        utils.SessionData.set(payload.sessionData, 0);
      }
      task = new commonDefines.TaskQueueData(JSON.parse(data));
      if (task) {
        ctx.initFromTaskQueueData(task);
        timeoutId = receiveTaskSetTimeout(ctx, task, ack, outParams);
        res = yield* ExecuteTask(ctx, task);
      }
    } catch (err) {
      ctx.logger.error(err);
    } finally {
      clearTimeout(timeoutId);
      if (!outParams.isAck) {
        yield ackTask(ctx, res, task, ack);
      }
    }
  });
}
function createErrorResponse(ctx, task){
  if (!task) {
    return null;
  }
  ctx.logger.debug('createErrorResponse');
  //simulate error response
  let cmd = task.getCmd();
  cmd.setStatusInfo(constants.CONVERT);
  let res = new commonDefines.TaskQueueData();
  res.setCtx(ctx);
  res.setCmd(cmd);
  return res;
}
function simulateErrorResponse(data){
  let task = new commonDefines.TaskQueueData(JSON.parse(data));
  let ctx = new operationContext.Context();
  ctx.initFromTaskQueueData(task);
  return createErrorResponse(ctx, task);
}
function run() {
  queue = new queueService(simulateErrorResponse);
  queue.on('task', receiveTask);
  queue.init(true, true, true, false, false, false, function(err) {
    if (null != err) {
      operationContext.global.logger.error('createTaskQueue error: %s', err.stack);
    }
  });
}
exports.run = run;
