export class FileUploader {
    public files: File[] = [];
    //fid should be returned from the first chunk sent to server
    private workingFile: { fn: string, xhr: XMLHttpRequest, fid: string };
    private uploadStatus: number; // 0:uploading/1:uploaded not responsed/2:responed
    private deleteQueue: Array<string> = [];
    private CHUNK_SIZE = 1000000;

    constructor(public config: UploaderConfig) {
        if (!config.UploadingServicelUrl) throw 'must specify uploading address';
    }

    // Upload if any file in the queue
    send(file: File) {
        this.files.push(file);
        this.sendInternal();
    }

    // Abort the file if in a uploading progress,
    // or delete if in a waiting queue
    abort(fn: string): boolean {
        var fs = this.files.filter(f => f.name == fn);
        if (fs.length > 0) {
            // in the waiting queue, then delete it
            var i = this.files.indexOf(fs[0]);
            this.files.splice(i, 1);
            console.log(`file [${fn}] removed from waiting queue`);
            return true;
        }
        else if (this.workingFile && this.workingFile.fn == fn) {
            // in the uploading progress, abort the XMLHttpRequest
            if (this.uploadStatus == 0) {
                this.workingFile.xhr.abort();
                console.log(`file [${fn}] aborted`);
                return true;
            } else if (this.uploadStatus == 1) {
                this.deleteQueue.push(fn);
            }
        }
        else {
            // uploaded
            return false;
        }
    }

    delete(fid: string) {
        this.config.OnDeleting(fid);
        // ajaxService('/Upload/DeleteSupportingFile?fid=' + fid,
        //     {
        //         method: 'POST',
        //         success: data => {
        //             //noop
        //         }
        //     });
    }

    private sendInternal() {
        if (this.files.length == 0) return;
        if (this.workingFile) return;
        var file = this.files.shift();
        this.workingFile = { fn: file.name, xhr: null, fid: '' };

        if (!this.config.Authenciation || this.config.Authenciation()) {
            this.sliceAndSend(file, (status, data) => {
                if (status == UploadStatus.FileStart) {
                    // file start uploading
                    this.config.OnStatusChanged(file.name, 'start');
                } else if (status == UploadStatus.FileProgress) {
                    // progressing
                    this.config.OnProgress(file.name, data);
                } else if (status == UploadStatus.FileEnd) {
                    // done
                    this.config.OnStatusChanged(file.name, 'end');
                } else if (status == UploadStatus.FileError) {
                    // error
                    this.config.OnStatusChanged(file.name, 'error', data);
                } else if (status == UploadStatus.FileAbort) {
                    // abort
                    this.config.OnStatusChanged(file.name, 'abort');
                }
                if (status == UploadStatus.FileEnd || status == UploadStatus.FileError || status == UploadStatus.FileAbort) {
                    this.workingFile = null;
                    this.sendInternal();
                }
            })
        }
    }

    private sliceAndSend(file: File, cb: (status: number, data?: any) => void) {
        var ins = this;
        var offset = 0;
        var seq = 0;
        var isLastChunk = false;

        seek();
        function seek() {
            var reader = new FileReader();
            if (offset >= file.size) return;
            var chunk = file.slice(offset, Math.min(offset + ins.CHUNK_SIZE, file.size));
            offset += chunk.size;
            if (offset >= file.size) {
                isLastChunk = true;
            }
            reader.onload = () => {
                var buffer = new Uint8Array(reader.result);
                ins.sendChunk(buffer, seq, isLastChunk, (status, data) => {
                    if (status == UploadStatus.XHRStart && seq == 0) {
                        cb(UploadStatus.FileStart);
                    } else if (status == UploadStatus.XHRProgress) {
                        // progressing
                        var totalPrct = ((seq * ins.CHUNK_SIZE + data) / file.size * 100 | 0);
                        // data loaded over total tested on  Chrome 58.0.3029.81 (64-bit) Ubuntu 16.04
                        cb(UploadStatus.FileProgress, Math.min(totalPrct, 100));
                    } else if (status == UploadStatus.XHRError) {
                        cb(UploadStatus.FileError, data);
                    } else if (status == UploadStatus.XHRAbort) {
                        cb(UploadStatus.FileAbort);
                    } else if (status == UploadStatus.XHREnd) {
                        seq++;
                        if (isLastChunk) cb(UploadStatus.FileEnd);
                        else setTimeout(seek.bind(ins), 0);
                    }
                });
            }
            reader.readAsArrayBuffer(chunk);
        }
    }

    private sendChunk(buffer: Uint8Array, seq: number, isLastChunk: boolean, cb: (status: number, data?: any) => void) {
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
        xhr.upload.onloadstart = () => {
            console.log(`file [${fn}.${seq}] start to upload`)
            if (seq == 0) {
                this.uploadStatus = 0;
            }
            cb(UploadStatus.XHRStart);
        };
        xhr.upload.onerror = ev => {
            console.log(`file [${fn}.${seq}] uploading encounter an error ${ev.error}`);
            cb(UploadStatus.XHRError, ev.error);
        };
        xhr.upload.onabort = ev => {
            cb(UploadStatus.XHRAbort);
        };
        xhr.upload.onprogress = target => {
            if (target.lengthComputable) {
                if (target.loaded >= target.total) this.uploadStatus = 1;
                cb(UploadStatus.XHRProgress, target.loaded);
            }
        };
        xhr.onreadystatechange = (ev) => {
            if (xhr.readyState === XMLHttpRequest.DONE) {
                this.uploadStatus = 2;
                var deleteIndex = this.deleteQueue.indexOf(fn);

                if (xhr.status === 200) {
                    var fid = xhr.responseText;
                    this.workingFile.fid = fid;
                    console.log(`file [${fn}] uploaded`);
                    if (deleteIndex != -1) {
                        this.delete(fid);
                        console.log(`file [${fn}] deleted on uploaded`);
                    }
                    cb(UploadStatus.XHREnd);
                }
                else {
                    console.log(`file [${fn}] uploading encounter an error`);
                    cb(UploadStatus.XHRError, xhr);
                }
                if (deleteIndex != -1) this.deleteQueue.splice(deleteIndex, 1);
            }
        };
        xhr.send(fd);
    }
}

enum UploadStatus {
    FileStart = 0,
    FileProgress = 1,
    FileEnd = 2,
    FileError = 3,
    FileAbort = 4,
    XHRStart = 5,
    XHRProgress = 6,
    XHREnd = 7,
    XHRError = 8,
    XHRAbort = 9
}

export class UploaderConfig {
    OnStatusChanged: (fn: string, status: 'start' | 'end' | 'error' | 'abort', data?: any) => void;
    OnProgress: (fn: string, prct: number) => void;
    OnUploading: (form: FormData, xhr: XMLHttpRequest) => void;
    OnDeleting: (fid: string) => void;

    Authenciation: () => boolean;

    constructor(public UploadingServicelUrl: string) {
        this.OnStatusChanged = noop;
        this.OnProgress = noop;
        this.OnUploading = noop;
        this.OnDeleting = noop;

        function noop() { }
    }
}

