define(["require", "exports"], function (require, exports) {
    "use strict";
    var FileUploader = (function () {
        function FileUploader(config) {
            this.config = config;
            this.files = [];
            this.deleteQueue = [];
            this.CHUNK_SIZE = 1000000;
            if (!config.UploadingServicelUrl)
                throw 'must specify uploading address';
        }
        // Upload if any file in the queue
        FileUploader.prototype.send = function (file) {
            this.files.push(file);
            this.sendInternal();
        };
        // Abort the file if in a uploading progress,
        // or delete if in a waiting queue
        FileUploader.prototype.abort = function (fn) {
            var fs = this.files.filter(function (f) { return f.name == fn; });
            if (fs.length > 0) {
                // in the waiting queue, then delete it
                var i = this.files.indexOf(fs[0]);
                this.files.splice(i, 1);
                console.log("file [" + fn + "] removed from waiting queue");
                return true;
            }
            else if (this.workingFile && this.workingFile.fn == fn) {
                // in the uploading progress, abort the XMLHttpRequest
                if (this.uploadStatus == 0) {
                    this.workingFile.xhr.abort();
                    console.log("file [" + fn + "] aborted");
                    return true;
                }
                else if (this.uploadStatus == 1) {
                    this.deleteQueue.push(fn);
                }
            }
            else {
                // uploaded
                return false;
            }
        };
        FileUploader.prototype.delete = function (fid) {
            this.config.OnDeleting(fid);
            // ajaxService('/Upload/DeleteSupportingFile?fid=' + fid,
            //     {
            //         method: 'POST',
            //         success: data => {
            //             //noop
            //         }
            //     });
        };
        FileUploader.prototype.sendInternal = function () {
            var _this = this;
            if (this.files.length == 0)
                return;
            if (this.workingFile)
                return;
            var file = this.files.shift();
            this.workingFile = { fn: file.name, xhr: null, fid: '' };
            if (!this.config.Authenciation || this.config.Authenciation()) {
                this.sliceAndSend(file, function (status, data) {
                    if (status == UploadStatus.FileStart) {
                        // file start uploading
                        _this.config.OnStatusChanged(file.name, 'start');
                    }
                    else if (status == UploadStatus.FileProgress) {
                        // progressing
                        _this.config.OnProgress(file.name, data);
                    }
                    else if (status == UploadStatus.FileEnd) {
                        // done
                        _this.config.OnStatusChanged(file.name, 'end');
                    }
                    else if (status == UploadStatus.FileError) {
                        // error
                        _this.config.OnStatusChanged(file.name, 'error', data);
                    }
                    else if (status == UploadStatus.FileAbort) {
                        // abort
                        _this.config.OnStatusChanged(file.name, 'abort');
                    }
                    if (status == UploadStatus.FileEnd || status == UploadStatus.FileError || status == UploadStatus.FileAbort) {
                        _this.workingFile = null;
                        _this.sendInternal();
                    }
                });
            }
        };
        FileUploader.prototype.sliceAndSend = function (file, cb) {
            var ins = this;
            var offset = 0;
            var seq = 0;
            var isLastChunk = false;
            seek();
            function seek() {
                var reader = new FileReader();
                if (offset >= file.size)
                    return;
                var chunk = file.slice(offset, Math.min(offset + ins.CHUNK_SIZE, file.size));
                offset += chunk.size;
                if (offset >= file.size) {
                    isLastChunk = true;
                }
                reader.onload = function () {
                    var buffer = new Uint8Array(reader.result);
                    ins.sendChunk(buffer, seq, isLastChunk, function (status, data) {
                        if (status == UploadStatus.XHRStart && seq == 0) {
                            cb(UploadStatus.FileStart);
                        }
                        else if (status == UploadStatus.XHRProgress) {
                            // progressing
                            var totalPrct = ((seq * ins.CHUNK_SIZE + data) / file.size * 100 | 0);
                            // data loaded over total tested on  Chrome 58.0.3029.81 (64-bit) Ubuntu 16.04
                            cb(UploadStatus.FileProgress, Math.min(totalPrct, 100));
                        }
                        else if (status == UploadStatus.XHRError) {
                            cb(UploadStatus.FileError, data);
                        }
                        else if (status == UploadStatus.XHRAbort) {
                            cb(UploadStatus.FileAbort);
                        }
                        else if (status == UploadStatus.XHREnd) {
                            seq++;
                            if (isLastChunk)
                                cb(UploadStatus.FileEnd);
                            else
                                setTimeout(seek.bind(ins), 0);
                        }
                    });
                };
                reader.readAsArrayBuffer(chunk);
            }
        };
        FileUploader.prototype.sendChunk = function (buffer, seq, isLastChunk, cb) {
            var _this = this;
            var fn = this.workingFile.fn;
            var blob = new Blob([buffer]);
            var fd = new FormData();
            fd.append('_upload', blob);
            fd.append('_seq', seq.toString());
            fd.append('_offset', (seq * this.CHUNK_SIZE).toString()); // can validate on server side
            fd.append('_fid', this.workingFile.fid); // empty for the first time
            fd.append('_isLastChunk', isLastChunk.toString());
            var xhr = new XMLHttpRequest();
            this.workingFile.xhr = xhr;
            xhr.open('POST', this.config.UploadingServicelUrl);
            xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
            xhr.upload.onloadstart = function () {
                console.log("file [" + fn + "." + seq + "] start to upload");
                if (seq == 0) {
                    _this.uploadStatus = 0;
                }
                cb(UploadStatus.XHRStart);
            };
            xhr.upload.onerror = function (ev) {
                console.log("file [" + fn + "." + seq + "] uploading encounter an error " + ev.error);
                cb(UploadStatus.XHRError, ev.error);
            };
            xhr.upload.onabort = function (ev) {
                cb(UploadStatus.XHRAbort);
            };
            xhr.upload.onprogress = function (target) {
                if (target.lengthComputable) {
                    if (target.loaded >= target.total)
                        _this.uploadStatus = 1;
                    cb(UploadStatus.XHRProgress, target.loaded);
                }
            };
            xhr.onreadystatechange = function (ev) {
                if (xhr.readyState === XMLHttpRequest.DONE) {
                    _this.uploadStatus = 2;
                    var deleteIndex = _this.deleteQueue.indexOf(fn);
                    if (xhr.status === 200) {
                        var fid = xhr.responseText;
                        _this.workingFile.fid = fid;
                        console.log("file [" + fn + "] uploaded");
                        if (deleteIndex != -1) {
                            _this.delete(fid);
                            console.log("file [" + fn + "] deleted on uploaded");
                        }
                        cb(UploadStatus.XHREnd);
                    }
                    else {
                        console.log("file [" + fn + "] uploading encounter an error");
                        cb(UploadStatus.XHRError, xhr);
                    }
                    if (deleteIndex != -1)
                        _this.deleteQueue.splice(deleteIndex, 1);
                }
            };
            xhr.send(fd);
        };
        return FileUploader;
    }());
    exports.FileUploader = FileUploader;
    var UploadStatus;
    (function (UploadStatus) {
        UploadStatus[UploadStatus["FileStart"] = 0] = "FileStart";
        UploadStatus[UploadStatus["FileProgress"] = 1] = "FileProgress";
        UploadStatus[UploadStatus["FileEnd"] = 2] = "FileEnd";
        UploadStatus[UploadStatus["FileError"] = 3] = "FileError";
        UploadStatus[UploadStatus["FileAbort"] = 4] = "FileAbort";
        UploadStatus[UploadStatus["XHRStart"] = 5] = "XHRStart";
        UploadStatus[UploadStatus["XHRProgress"] = 6] = "XHRProgress";
        UploadStatus[UploadStatus["XHREnd"] = 7] = "XHREnd";
        UploadStatus[UploadStatus["XHRError"] = 8] = "XHRError";
        UploadStatus[UploadStatus["XHRAbort"] = 9] = "XHRAbort";
    })(UploadStatus || (UploadStatus = {}));
    var UploaderConfig = (function () {
        function UploaderConfig(UploadingServicelUrl) {
            this.UploadingServicelUrl = UploadingServicelUrl;
            this.OnStatusChanged = noop;
            this.OnProgress = noop;
            this.OnUploading = noop;
            this.OnDeleting = noop;
            function noop() { }
        }
        return UploaderConfig;
    }());
    exports.UploaderConfig = UploaderConfig;
});
