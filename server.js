var http = require('http')
var formidable = require('formidable');
var util = require('util');
const uuidv4 = require('uuid/v4');

var srv = http.createServer((req, resp) => {
    var fid = '';
    resp.writeHead(200, {
        "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "X-Requested-With"
    });

    // parse a file upload 
    var form = new formidable.IncomingForm();
    form.uploadDir = '.';
    form
        .on('field', function (field, value) {
            if(field == '_seq' && value == '0'){
                fid = uuidv4();
            }
            else if(field == '_fid' && value != ''){
                fid = value;
            }
        })
        .on('file', function (field, file) {
            console.log(`file in ${field}`)
        })
        .on('end', function(){
            resp.end(fid);
        })
        .parse(req);
})

srv.listen(8082);