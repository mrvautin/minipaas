#!/usr/bin/env node
var program = require('commander');
var Ssh = require('node-ssh');
var chalk = require('chalk');
var path = require('path');
var async = require('async');
var fs = require('fs');
var _ = require('lodash');
var scpClient = require('scp2');
var Spinner = require('ora');
var moment = require('moment');
var prompt = require('prompt');
var archiver = require('archiver');
var recursive = require('recursive-readdir');
var execSync = require('child_process').execSync;
const log = console.log;

// setup program/CLI
program
  .version('0.0.1')
  .option('init', 'Init a new app config')
  .option('deploy', 'Deploy to remote server - Add <norestart> to not restart app')
  .option('list', 'List commits')
  .option('compare', 'Outputs the difference between remote and local')
  .option('rebuild', 'Warning: Removes ALL remote files and uploads the local app')
  .option('restart <app>', 'Restarts the app on the remote server')
  .parse(process.argv);

// setup CLI spinner
var spinner = new Spinner(chalk.cyan());

// check for package.json file
if(!fs.existsSync(path.join(process.cwd(), 'package.json'))){
    log(chalk.red('[ERROR] No packge.json file exists. Please create and try again.'));
    process.exit(5);
}

// get config if exists
var config = {};
if(fs.existsSync(path.join(process.cwd(), '.minipaas'))){
    config = fs.readFileSync(path.join(process.cwd(), '.minipaas'), 'utf8');
    try{
        config = JSON.parse(config);
    }catch(ex){
        log(chalk.red('[ERROR] Error parsing config file. Please check your config file.'));
        process.exit(5);
    }
}

// configs
var fullLocalPath = process.cwd();
var packageJsonConfig = JSON.parse(fs.readFileSync(path.join(fullLocalPath, 'package.json'), 'utf8'));
var privKeyPath = '';
if(typeof config.hostKeyFilePath !== 'undefined'){
    if(fs.existsSync(config.hostKeyFilePath)){
        privKeyPath = fs.readFileSync(config.hostKeyFilePath);
    }else{
        // show error and exit if not doing an init
        if(!program.init){
            log(chalk.red('[ERROR] A keyfile path has been provided which does not exist.'));
            process.exit(5);
        }
    }
}

// setup scp options
var connectOpts = {
    host: config.hostAddress,
    port: config.hostPort,
    username: config.hostUsername,
    privateKey: privKeyPath,
    path: config.remotePath
};

// setup SSH client
var sshClient = new Ssh();
var sshOptions = {
    host: connectOpts.host,
    port: connectOpts.port,
    username: connectOpts.username,
    privateKey: config.hostKeyFilePath
};

// direct from command
if(program.init){
    init();
}
if(program.deploy){
    deploy(null, program.args);
}
if(program.list){
    list();
}
if(program.compare){
    compare();
}
if(program.rebuild){
    rebuild();
}
if(program.restart){
    restart(program.restart);
}

// if no commands are found, show help and exit
if(!program.init && !program.deploy && !program.list && !program.sync && !program.compare && !program.rebuild && !program.restart){
    program.help();
}

// inits the .minipaas config file
function init(){
    log(chalk.yellow('[INFO] Setting up a new miniPaaS config'));

    var appName = typeof config.appName === 'undefined' || config.appName === '' ? '' : '(' + config.appName + ')';
    var hostAddress = typeof config.hostAddress === 'undefined' || config.hostAddress === '' ? '' : '(' + config.hostAddress + ')';
    var hostPort = typeof config.hostPort === 'undefined' || config.hostPort === '' ? '' : '(' + config.hostPort + ')';
    var hostUsername = typeof config.hostUsername === 'undefined' || config.hostUsername === '' ? '' : '(' + config.hostUsername + ')';
    var hostPassword = typeof config.hostPassword === 'undefined' || config.hostPassword === '' ? '' : '(' + config.hostPassword + ')';
    var hostKeyFilePath = typeof config.hostKeyFilePath === 'undefined' || config.hostKeyFilePath === '' ? '' : '(' + config.hostKeyFilePath + ')';
    var remotePath = typeof config.remotePath === 'undefined' || config.remotePath === '' ? '' : '(' + config.remotePath + ')';
    var pm2ProcessName = typeof config.pm2ProcessName === 'undefined' || config.pm2ProcessName === '' ? '' : '(' + config.pm2ProcessName + ')';

    // show prompts
    prompt.start();
    prompt.get({
        properties: {
            appName: {
                description: chalk.grey('App Name ') + chalk.cyan(appName)
            },
            hostAddress: {
                description: chalk.grey('Host address ') + chalk.cyan(hostAddress)
            },
            hostPort: {
                description: chalk.grey('Host SSH port ') + chalk.cyan(hostPort)
            },
            hostUsername: {
                description: chalk.grey('Host username - eg: root ') + chalk.cyan(hostUsername)
            },
            hostPassword: {
                description: chalk.grey('Host password (optional if keyfile being used) ') + chalk.cyan(hostPassword)
            },
            hostKeyFilePath: {
                description: chalk.grey('Keyfile path - eg: /User/tim/.ssh/id_rsa ') + chalk.cyan(hostKeyFilePath)
            },
            remotePath: {
                description: chalk.grey('Remote path to app ') + chalk.cyan(remotePath)
            },
            pm2ProcessName: {
                description: chalk.grey('The process name or index of app in PM2 (leave blank to start new) ') + chalk.cyan(pm2ProcessName)
            }
        }
    }, function (err, result){
        if(!err){
            config.appName = result.appName !== '' && result.appName !== null ? result.appName : config.appName;
            config.hostAddress = result.hostAddress !== '' && result.hostAddress !== null ? result.hostAddress : config.hostAddress;
            config.hostPort = result.hostPort !== '' && result.hostPort !== null ? result.hostPort : config.hostPort;
            config.hostUsername = result.hostUsername !== '' && result.hostUsername !== null ? result.hostUsername : config.hostUsername;
            config.hostPassword = result.hostPassword !== '' && result.hostPassword !== null ? result.hostPassword : config.hostPassword;
            config.hostKeyFilePath = result.hostKeyFilePath !== '' && result.hostKeyFilePath !== null ? result.hostKeyFilePath : config.hostKeyFilePath;
            config.remotePath = result.remotePath !== '' && result.remotePath !== null ? result.remotePath : config.remotePath;
            config.pm2ProcessName = result.pm2ProcessName !== '' && result.pm2ProcessName !== null ? result.pm2ProcessName : config.pm2ProcessName;

            // write out the file
            fs.writeFileSync(path.join(process.cwd(), '.minipaas'), JSON.stringify(config, null, 4));
            log(chalk.green('App successfully setup'));
        }
    });
}

// lists commits stored in the config file
function list(){
    var commitIndex = 0;
    var commitArray = [];
    _.forEach(config.commits, function(value, key){
        var updatedFiles = typeof value.updated !== 'undefined' && value.updated.length > 0 ? value.updated : 'Nothing';
        var removedFiles = typeof value.removed !== 'undefined' && value.removed.length > 0 ? value.removed : 'Nothing';
        log(chalk.green(commitIndex) + ' (' + key + ') - ' + chalk.magenta('(' + moment(value.date).format('DD/MM/YYYY hh:mma') + ') ') + chalk.yellow(' - Message: ' + value.message) + ', ' + chalk.cyan('Updated: ' + updatedFiles + ', Removed: ' + removedFiles));
        commitArray.push(key);
        commitIndex++;
    });
    log(chalk.red('Press "ctrl+c" or "x" to cancel'));

    // show prompt
    prompt.start();
    prompt.get({
        properties: {
            gitCommit: {
                description: chalk.grey('Pick a commit to deploy: '),
                required: true
            }
        }
    }, function (err, result){
        if(!err){
            if(parseInt(result.gitCommit) < 0 || parseInt(result.gitCommit) > commitArray.length - 1){
                log(chalk.red('Commit not found. Please enter the correct index number.'));
                process.exit(5);
            }

            // call deploy on the chosen commit
            if(typeof commitArray[parseInt(result.gitCommit)] !== 'undefined'){
                deploy(commitArray[parseInt(result.gitCommit)], []);
            }
        }
    });
}

// prints a list of files which don't exist locally vs remotely
function compare(){
    spinner.start();
    getFileDiff(function(err, data){
        spinner.stop();

        // print local exceptions
        spinner.start();
        log(chalk.yellow('Files which exist locally and not remotely:'));
        _.forEach(data.localDiff, function(value){
            log(chalk.grey('-> ' + value));
        });
        spinner.stop();

        log(''); // blank line

        // print remote exceptions
        spinner.start();
        log(chalk.yellow('Files which exist remotely and not locally:'));
        _.forEach(data.remoteDiff, function(value){
            log(chalk.grey('-> ' + value));
        });
        spinner.stop();
        process.exit();
    });
};

function rebuild(){
    prompt.start();

    // remove old local rebuild.zip
    execSync('rm -rf rebuild.zip');

    prompt.get({
        properties: {
            rebuildWarning: {
                description: chalk.red('Warning: This removes ALL remote files and uploads the local ones. Write "yes" to continue'),
                required: true,
                type: 'string'
            }
        }
    }, function (err, result){
        if(!err && result.rebuildWarning === 'yes'){
            var ignore = [
                'node_modules',
                '.git',
                '.DS_Store',
                '.gitignore',
                '.minipaas'
            ];

            recursive('.', ignore, function (err, localFiles){
                if(err){
                    log(chalk.red('[ERROR] Error building local file list: ' + err));
                    process.exit(5);
                }
                async.series({
                    checkSCPLogin: function(callback){
                        testSCP(function(err){
                            if(err){
                                log(chalk.red('Error connecting via SCP: Error code: ', err.code));
                                process.exit(5);
                            }
                            callback();
                        });
                    },
                    checkSSHLogin: function(callback){
                        testSSH(function(err){
                            if(err){
                                log(chalk.red('Error connecting via SSH: Error code: ', err.code));
                                process.exit(5);
                            }
                            callback();
                        });
                    },
                    removeOldStuff: function(callback){
                        sshClient.connect(sshOptions)
                        .then(function(){
                            sshClient.execCommand('find -mindepth 1 -delete', {cwd: config.remotePath}).then(function(result){
                                spinner.stop();
                                if(result.code !== 0){
                                    log(chalk.red('[ERROR] Unable to clean app. You may need to manually delete files'));
                                    process.exit(5);
                                }else{
                                    log(chalk.yellow('[INFO] App cleaned ready for rebuild'));
                                }
                                spinner.stop();
                                callback();
                            });
                        });
                    },
                    createRebuildZip: function(callback){
                        createZip(localFiles, 'rebuild.zip', function(err){
                            spinner.stop();
                            log(chalk.yellow('[INFO] Payload successfully created'));
                            callback();
                        });
                    },
                    uploadRebuildZip: function(callback){
                        spinner.start();
                        scpClient.scp('rebuild.zip', connectOpts, function(err){
                            spinner.stop();
                            if(err){
                                log(chalk.red('[ERROR] Error uploading the rebuild payload'));
                                process.exit(5);
                            }
                            log(chalk.yellow('[INFO] Rebuild payload uploaded'));

                            // remove old local rebuild.zip
                            execSync('rm -rf rebuild.zip');

                            callback();
                        });
                    },
                    unzipRebuildZip: function(callback){
                        // unzip the rebuild file
                        sshClient.connect(sshOptions)
                        .then(function(){
                            spinner.start();
                            // unzip the rebuild payload
                            sshClient.execCommand('unzip -o rebuild.zip', {cwd: config.remotePath}).then(function(result){
                                spinner.stop();
                                if(result.code !== 0){
                                    log(chalk.red('[ERROR] Command: ' + 'unzip -o rebuild.zip') + chalk.red(' - Result: Failed'));
                                    process.exit(5);
                                }else{
                                    log(chalk.yellow('[INFO] Rebuild payload extracted'));
                                    callback();
                                }
                            });
                        });
                    }
                }, function(err, results){
                    // remove rebuild payload and finish up
                    spinner.start();
                    sshClient.execCommand('rm -rf rebuild.zip', {cwd: config.remotePath}).then(function(result){
                        spinner.stop();
                        if(result.code !== 0){
                            log(chalk.red('[ERROR] Command: ' + 'rm -rf rebuild.zip') + chalk.red(' - Result: Failed'));
                            process.exit(5);
                        }else{
                            log(chalk.yellow('[INFO] Rebuild payload cleaned up'));

                            // run the install and restart commands and exit
                            runCommands(false, function(err, result){
                                // exit process
                                process.exit(0);
                            });
                        }
                    });
                });
            });
        }else{
            process.exit(0);
        }
    });
}

// deply new files remotely
function deploy(commit, args){
    // check for an empty config
    if(Object.keys(config).length === 0){
        log(chalk.red('[ERROR] No config exists. To setup your project, run: # minipaas init'));
        process.exit(5);
    }

    // norestart arg supplied?
    var restartApp = _.includes(args, 'norestart');

    // get the git commit file list
    var gitLastCommit = execSync('git log -n 1 --pretty=format:"%h"').toString();

    // if a commit is supplied to the deploy function then we use that instead
    if(typeof commit !== 'undefined' && commit !== null){
        gitLastCommit = commit;
    }

    // set the working commit
    var workingCommit = gitLastCommit;

    // get our changes
    var gitUpdateFilesCommand = execSync('git show --all --pretty=format: --name-only --diff-filter=ARCMTUXB ' + gitLastCommit);
    var gitRemoveFilesCommand = execSync('git show --all --pretty=format: --name-only --diff-filter=D ' + gitLastCommit);
    var gitCommitMessage = execSync('git log -n 1 --pretty=format:%s ' + gitLastCommit).toString();

    var gitUpdateFileList = gitUpdateFilesCommand.toString().split('\n').filter(function(n){ return n !== ''; });
    var gitRemoveFileList = gitRemoveFilesCommand.toString().split('\n').filter(function(n){ return n !== ''; });

    // check if commit exits in the successful stored array
    if(typeof commit === 'undefined' || commit === null && typeof config.commits !== 'undefined' && typeof config.commits[workingCommit] !== 'undefined'){
        log(chalk.yellow('[INFO] Nothing to deploy'));
        process.exit(5);
    }

    // setup scp defaults
    scpClient.defaults(connectOpts);

    async.series({
        checkSCPLogin: function(callback){
            testSCP(function(err){
                if(err){
                    log(chalk.red('Error connecting via SCP: Error code: ', err.code));
                    process.exit(5);
                }
                callback();
            });
        },
        checkSSHLogin: function(callback){
            testSSH(function(err){
                if(err){
                    log(chalk.red('Error connecting via SSH: Error code: ', err.code));
                    process.exit(5);
                }else{
                    callback();
                }
            });
        },
        createZip: function(callback){
            createZip(gitUpdateFileList, workingCommit + '.zip', function(err){
                callback(err);
            });
        },
        outputFileListDefails: function(callback){
            log(chalk.yellow('[INFO] Files listed for deploy'));
            _.forEach(gitUpdateFileList, function(value){
                log(chalk.grey('-> ' + value + ' (Update)'));
            });
            _.forEach(gitRemoveFileList, function(value){
                log(chalk.grey('-> ' + value + ' (Remove)'));
            });

            // if git commit list equals undefined or empty
            if(gitRemoveFileList.length === 0 && gitUpdateFileList.length === 0){
                log(chalk.yellow('[INFO] No files to deploy. Run commands: "#git add ." then "#git commit -m \'My commit message\'"'));
                process.exit(5);
            }

            // finish and callback
            callback();
        },
        removeFiles: function(callback){
            log(chalk.yellow('[INFO] Updating files. Depending on the changes this might take a while...'));
            if(gitRemoveFileList.length > 0){
                // loop files to remove
                async.eachSeries(gitRemoveFileList, function(file, removeCallback){
                    spinner.start();
                    sshClient.connect(sshOptions)
                    .then(function(){
                        sshClient.execCommand('rm ' + file, {cwd: config.remotePath}).then(function(result){
                            spinner.stop();
                            if(result.code === 0){
                                log(chalk.grey('[INFO] File removed: ' + file));
                                removeCallback();
                            }else{
                                log(chalk.red('[ERROR] Removing file: ' + file));
                                removeCallback(result.stderr);
                            }
                        });
                    });
                }, function(err){
                    // handle error, success
                    if(err){
                        spinner.stop();
                        // dont kill the app on failed deleted files. Just warn for manual cleanup
                        if(err.toString().substring(0, 17) === 'rm: cannot remove'){
                            log(chalk.red('[ERROR] The following files could not be deleted: ', err));
                            callback();
                        }else{
                            log(chalk.red('[ERROR] The process failed due to: ', err));
                            process.exit(5);
                        }
                    }else{
                        callback();
                    }
                });
            }else{
                callback();
            }
        },
        checkRemoveDir: function(callback){
            // create dir if doesnt exist
            sshClient.connect(sshOptions)
            .then(function(){
                sshClient.execCommand('mkdir -p ' + config.remotePath, {cwd: config.remotePath}).then(function(result){
                    callback();
                });
            });
        },
        uploadZip: function(callback){
            if(fs.existsSync(workingCommit + '.zip')){
                spinner.start();
                scpClient.scp(workingCommit + '.zip', connectOpts, function(err){
                    spinner.stop();
                    if(err){
                        log(chalk.red('[ERROR] Failed to upload the payload: ', err));
                        callback(err);
                    }

                    // unzip on the remote server
                    sshClient.connect(sshOptions)
                    .then(function(){
                        sshClient.execCommand('unzip -o ' + workingCommit + '.zip', {cwd: config.remotePath}).then(function(result){
                            if(result.code !== 0){
                                if(result.stderr === 'bash: unzip: command not found'){
                                    log(chalk.red('[ERROR] unzip not installed: Install on remote server with: #apt install unzip or #yum install unzip'));
                                }
                                callback(result.stderr);
                            }else{
                                // remove zip
                                sshClient.execCommand('rm -rf ' + workingCommit + '.zip', {cwd: config.remotePath}).then(function(result){
                                    if(result.code !== 0){
                                        log(chalk.red('[ERROR] Command: ' + 'rm -rf ' + workingCommit + '.zip') + chalk.red(' - Result: Failed'));
                                        callback(result.stderr);
                                    }
                                    callback();
                                });
                            }
                        });
                    });
                });
            }else{
                // show message if there was supposed to be a zip
                if(gitUpdateFileList.lenght > 0){
                    log(chalk.red('[ERROR] Zip file doesnt exist'));
                }
                callback();
            }
        },
        runCommands: function(callback){
            // start executing remote SSH commands
            sshClient.connect(sshOptions)
            .then(function(){
                runCommands(restartApp, function(err, result){
                    callback(err);
                });
            });
        }
    }, function(err, results){
        // Finish up

        // store our commit in our config so we dont keep pushing the same commit
        if(typeof config.commits === 'undefined'){
            config.commits = {};
        }
        if(typeof config.commits[gitLastCommit] === 'undefined'){
            config.commits[gitLastCommit] = {removed: gitRemoveFileList, updated: gitUpdateFileList, message: gitCommitMessage, date: new Date()};
        }
        // write out the changes to the config
        fs.writeFileSync(path.join(process.cwd(), '.minipaas'), JSON.stringify(config, null, 4));

        // remove local zip file
        execSync('rm -rf ' + workingCommit + '.zip');

        // exit process
        process.exit(0);
    });
}

// restart app by name/index
function restart(args){
    sshClient.connect(sshOptions)
    .then(function(){
        // restart app
        sshClient.execCommand('pm2 restart ' + args, {cwd: config.remotePath}).then(function(result){
            if(result.code !== 0){
                log(chalk.red('[ERROR] Failed to restart application: ' + result.stderr));
                process.exit(0);
            }else{
                log(chalk.yellow('[INFO] Application successfully restarted'));
                process.exit(0);
            }
        });
    }).catch(function(err){
        log(chalk.red('Error connecting via SSH: Error code: ', err.code));
        process.exit(5);
    });
}

function createZip(files, filename, callback){
    // callback if no files
    if(typeof files === 'undefined' || files.length === 0){
        callback();
    }else{
        // build our zip
        var archive = archiver('zip', {
            store: true
        });

        var zipFile = fs.createWriteStream(filename);
        _.forEach(files, function(value){
            archive.file(value);
        });

        // write our zip file to disk
        archive.finalize();
        archive.pipe(zipFile);

        // catch zip writing errors
        archive.on('error', function(err){
            callback(err);
        });

        // zip write complete
        zipFile.on('close', function(){
            callback();
        });
    }
}

function runCommands(noRestartApp, callback){
    var sshCommands = [];
    sshCommands.push({cmd: 'npm install'});

    // if there is a pm2 index supplied
    if(typeof config.pm2ProcessName !== 'undefined' && config.pm2ProcessName !== ''){
        // add to the list of commands
        sshCommands.push({cmd: 'pm2 restart ' + config.pm2ProcessName});
    }else{
        // do a simple start on the package.json main entry point with a name of in the packag.json file
        if(typeof packageJsonConfig.scripts.start === 'undefined'){
            log(chalk.red('[ERROR] Cannot start a new PM2 process as the start script in the package.json has not been set'));
            process.exit(0);
        }
        // set the new process name in the config
        config.pm2ProcessName = packageJsonConfig.name;

        // set the restart command and save
        sshCommands.push({cmd: 'pm2 start ' + packageJsonConfig.scripts.start + ' -n ' + packageJsonConfig.name});
        sshCommands.push({cmd: 'pm2 save'});
    }

    // if no restart arg supplied, remove the command
    if(noRestartApp === true){
        log(chalk.yellow('[INFO] Deploying with no restart'));
        delete sshCommands.pm2RestartApp;
    }

    spinner.start();
    async.eachOfSeries(sshCommands, function (value, key, callback){
        spinner.start();
        sshClient.execCommand(value.cmd, {cwd: config.remotePath}).then(function(result){
            spinner.stop();
            if(result.code !== 0){
                log(chalk.red('[ERROR] Command: ' + value.cmd) + chalk.red(' - Result: Failed'));
                callback(result.stderr);
            }else{
                log(chalk.grey('[INFO] Command: ' + value.cmd) + chalk.cyan(' - Result: Success'));
                callback();
            }
        });
    }, function (err){
        if(err){
            // give help on common errors
            if(err === 'bash: npm: command not found'){
                log(chalk.red('[ERROR] npm is not installed on the remote server. Install with: #apt install npm or #yum install npm'));
                process.exit(5);
            }

            if(err === 'bash: pm2: command not found'){
                log(chalk.red('[ERROR] The PM2 module was not installed on the server. Please SSH into your server and run: #npm install pm2 -g'));
                process.exit(5);
            }

            if(err === '[PM2][ERROR] Process ' + config.pm2ProcessName + ' not found'){
                log(chalk.red('[ERROR] The PM2 process was not found. Please run `minipaas init` to correct the PM2 process name.'));
                process.exit(5);
            }
            if(err.substring(0, 29) === '[PM2][ERROR] script not found'){
                log(chalk.red('[ERROR] The start script in the package.json is pointing to a file which does not exist.'));
                process.exit(5);
            }

            if(err.substring(0, 36) === '[PM2][ERROR] Script already launched'){
                log(chalk.red('[ERROR] The app is already started in PM2. Please run "# minipaas init" and set your PM2 app name or index.'));
                process.exit(5);
            }

            log(chalk.red('[ERROR] There was a problem processing a command: ', err));
            process.exit(5);
        }
        spinner.stop();
        log(chalk.green('[INFO] New version successfully deployed'));
        callback();
    });
}

// Test the SSH connection credentials
function testSSH(callback){
    spinner.start();
    sshClient.connect(sshOptions)
    .then(function(){
        spinner.stop();
        callback();
    }).catch(function(err){
        spinner.stop();
        callback(err);
    });
}

// Test the SCP connection credentials
function testSCP(callback){
    // upload a test file - Seems there is no better way
    spinner.start();
    scpClient.write({
        destination: path.join(config.remotePath, 'textscpfile.txt'),
        content: new Buffer(8)
    }, function(err, data){
        spinner.stop();
        if(err){
            callback(err);
        }else{
            // remove the test file
            sshClient.connect(sshOptions)
            .then(function(){
                sshClient.execCommand('rm -rf textscpfile.txt', {cwd: config.remotePath}).then(function(result){   
                    callback();
                });
            }).catch(function(err){
                callback(err);
            });
        }
    });

    // catch errors
    scpClient.on('error', function(err){
        callback(err);
    });
}

// builds a file difference between remote and local
function getFileDiff(callback){
    var ignore = [
        'node_modules',
        '.git',
        '.DS_Store',
        '.gitignore',
        '.minipaas'
    ];
    // Test SSH first
    testSSH(function(err){
        recursive('.', ignore, function (err, localFiles){
            sshClient.connect(sshOptions)
            .then(function(){
                // create directory if does exist
                sshClient.execCommand('find -name "*.*" -not -path "./node_modules/*" | sed "s|^./||"', {cwd: config.remotePath}).then(function(remoteFileCmd){
                    var remoteFiles = remoteFileCmd.stdout.split('\n').filter(function(n){ return n !== ''; });
                    var remoteDiff = _.differenceWith(remoteFiles, localFiles, _.isEqual);
                    var localDiff = _.differenceWith(localFiles, remoteFiles, _.isEqual);

                    callback(null, {remoteDiff: remoteDiff, localDiff: localDiff});
                });
            });
        });
    });
};
