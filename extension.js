const vscode = require('vscode');
const Docker = require('dockerode');
const docker = new Docker();

const outputChannel = vscode.window.createOutputChannel("SQL Docker Debug");

function activate(context) {
    let importDisposable = vscode.commands.registerCommand('docker-sql-import.importBacpac', async () => {
        await handleBacpacTask('Import');
    });

    let exportDisposable = vscode.commands.registerCommand('docker-sql-import.exportBacpac', async () => {
        await handleBacpacTask('Export');
    });

    let deleteDisposable = vscode.commands.registerCommand('docker-sql-import.deleteDatabase', async () => {
        await handleDeleteDatabase();
    });

    context.subscriptions.push(importDisposable, exportDisposable, deleteDisposable, outputChannel);
}

async function handleDeleteDatabase() {
    try {
        const containers = await docker.listContainers();
        if (containers.length === 0) {
            vscode.window.showErrorMessage('No running Docker containers found.');
            return;
        }

        const containerItems = containers.map(c => ({
            label: c.Names[0].replace('/', ''),
            description: c.Image,
            id: c.Id
        }));

        const selectedContainer = await vscode.window.showQuickPick(containerItems, {
            placeHolder: 'Select the SQL Server container'
        });
        if (!selectedContainer) return;

        const saPassword = await vscode.window.showInputBox({ prompt: 'SA Password', password: true });
        if (!saPassword) return;

        const container = docker.getContainer(selectedContainer.id);
        const databases = await listDatabases(container, saPassword);

        if (!databases || databases.length === 0) {
            vscode.window.showInformationMessage('No user databases found.');
            return;
        }

        const selectedDb = await vscode.window.showQuickPick(databases, { placeHolder: 'Select the Database to DELETE' });
        if (!selectedDb) return;

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete database [${selectedDb}]? This cannot be undone.`,
            { modal: true },
            'Yes'
        );
        if (confirm !== 'Yes') return;

        const sqlCmdPath = await findSqlCmd(container);
        const query = `ALTER DATABASE [${selectedDb}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${selectedDb}];`;
        
        const exec = await container.exec({
            Cmd: [sqlCmdPath, "-S", "localhost", "-U", "sa", "-P", saPassword, "-Q", query, "-b", "-C"],
            AttachStdout: true, AttachStderr: true
        });

        const stream = await exec.start();
        
        await new Promise((resolve, reject) => {
            let errorOutput = '';
            stream.on('data', chunk => {
                let offset = 0;
                while (offset < chunk.length) {
                    const length = chunk.readUInt32BE(offset + 4);
                    errorOutput += chunk.slice(offset + 8, offset + 8 + length).toString('utf8');
                    offset += 8 + length;
                }
            });

            const checkStatus = setInterval(async () => {
                const inspect = await exec.inspect();
                if (!inspect.Running) {
                    clearInterval(checkStatus);
                    if (inspect.ExitCode !== 0) {
                        reject(new Error(errorOutput || `Exit Code: ${inspect.ExitCode}`));
                    } else {
                        resolve();
                    }
                }
            }, 200);
        });

        vscode.window.showInformationMessage(`Database ${selectedDb} deleted successfully.`);
    } catch (err) {
        outputChannel.appendLine(`[DELETE ERROR] ${err.message}`);
        outputChannel.show();
        vscode.window.showErrorMessage(`Failed to delete: ${err.message}`);
    }
}

async function handleBacpacTask(action) {
    try {
        const containers = await docker.listContainers();
        if (containers.length === 0) {
            vscode.window.showErrorMessage('No running Docker containers found.');
            return;
        }

        const containerItems = containers.map(c => ({
            label: c.Names[0].replace('/', ''),
            description: c.Image,
            id: c.Id
        }));

        const selectedContainer = await vscode.window.showQuickPick(containerItems, {
            placeHolder: `Select the SQL Server container for ${action}`
        });
        if (!selectedContainer) return;

        const container = docker.getContainer(selectedContainer.id);
        let sqlPackagePath = await findSqlPackage(container);

        if (!sqlPackagePath) {
            const install = await vscode.window.showWarningMessage(
                'SqlPackage not found. Do you want to try automatic installation?',
                'Yes', 'No'
            );
            if (install === 'Yes') {
                sqlPackagePath = await installSqlPackage(container, selectedContainer.label);
            } else {
                return;
            }
        }

        const saPassword = await vscode.window.showInputBox({ prompt: 'SA Password', password: true });
        if (!saPassword) return;

        let dbName;
        if (action === 'Export') {
            const databases = await listDatabases(container, saPassword);
            if (!databases || databases.length === 0) {
                outputChannel.appendLine("[WARNING] Database list is empty. Requesting manual entry.");
                dbName = await vscode.window.showInputBox({ prompt: 'Database Name (Manual)' });
            } else {
                const selectedDb = await vscode.window.showQuickPick(databases, { placeHolder: 'Select the Database to export' });
                if (!selectedDb) return;
                dbName = selectedDb;
            }
        } else {
            dbName = await vscode.window.showInputBox({ prompt: 'New Database Name' });
        }
        if (!dbName) return;

        let filePath;
        if (action === 'Import') {
            const fileUri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'Bacpac Files': ['bacpac'] }
            });
            if (!fileUri || !fileUri[0]) return;
            filePath = fileUri[0].fsPath;
        } else {
            const fileUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${dbName}.bacpac`),
                filters: { 'Bacpac Files': ['bacpac'] }
            });
            if (!fileUri) return;
            filePath = fileUri.fsPath;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `${action === 'Import' ? 'Importing' : 'Exporting'} BACPAC: ${dbName}`,
            cancellable: false
        }, async (progress) => {
            const fileName = `task_${Date.now()}.bacpac`;
            const containerPath = `/tmp/${fileName}`;
            const escapedPassword = saPassword.replace(/'/g, "''");
            const connStr = `Server=127.0.0.1;Database='${dbName}';User ID=sa;Password='${escapedPassword}';Encrypt=False;TrustServerCertificate=True;`;

            outputChannel.clear();
            outputChannel.show();

            if (action === 'Import') {
                progress.report({ message: "Copying to container..." });
                const cpTerminal = vscode.window.createTerminal('SQL CP');
                cpTerminal.sendText(`docker cp "${filePath}" ${selectedContainer.label}:${containerPath}`);
                await new Promise(r => setTimeout(r, 2000));

                const exec = await container.exec({
                    Cmd: ['sh', '-c', `"${sqlPackagePath}" /Action:Import /SourceFile:"${containerPath}" /TargetConnectionString:"${connStr}"`],
                    AttachStdout: true, AttachStderr: true
                });
                await runExecWithProgress(exec, progress);
                await container.exec({ Cmd: ['rm', containerPath] }).then(e => e.start());
            } else {
                const exec = await container.exec({
                    Cmd: ['sh', '-c', `"${sqlPackagePath}" /Action:Export /TargetFile:"${containerPath}" /SourceConnectionString:"${connStr}"`],
                    AttachStdout: true, AttachStderr: true
                });
                await runExecWithProgress(exec, progress);

                progress.report({ message: "Copying to host..." });
                const cpTerminal = vscode.window.createTerminal('SQL CP');
                cpTerminal.sendText(`docker cp ${selectedContainer.label}:${containerPath} "${filePath}"`);
                await new Promise(r => setTimeout(r, 4000));
                await container.exec({ Cmd: ['rm', containerPath] }).then(e => e.start());
            }
        });

        vscode.window.showInformationMessage(`${action} completed.`);
    } catch (err) {
        outputChannel.appendLine(`[ERROR] ${err.message}`);
        vscode.window.showErrorMessage(err.message);
    }
}

async function listDatabases(container, password) {
    try {
        const sqlCmdPath = await findSqlCmd(container);
        if (!sqlCmdPath) return [];

        const query = "SET NOCOUNT ON; SELECT name FROM sys.databases WHERE name NOT IN ('master','tempdb','model','msdb')";
        const exec = await container.exec({
            Cmd: [sqlCmdPath, "-S", "localhost", "-U", "sa", "-P", password, "-Q", query, "-h", "-1", "-W", "-C"],
            AttachStdout: true, AttachStderr: true
        });

        const stream = await exec.start();
        return new Promise(resolve => {
            let output = '';
            stream.on('data', chunk => {
                let offset = 0;
                while (offset < chunk.length) {
                    const length = chunk.readUInt32BE(offset + 4);
                    output += chunk.slice(offset + 8, offset + 8 + length).toString('utf8');
                    offset += 8 + length;
                }
            });

            stream.on('end', () => {
                const databases = output.split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(line => line.length > 0);
                resolve(databases);
            });
            setTimeout(() => resolve([]), 5000);
        });
    } catch (e) { return []; }
}

async function runExecWithProgress(exec, progress) {
    const stream = await exec.start();
    return new Promise((resolve, reject) => {
        stream.on('data', chunk => {
            let offset = 0;
            let log = '';
            while (offset < chunk.length) {
                const length = chunk.readUInt32BE(offset + 4);
                log += chunk.slice(offset + 8, offset + 8 + length).toString('utf8');
                offset += 8 + length;
            }
            const cleanLog = log.trim();
            if (cleanLog) {
                outputChannel.appendLine(`[LOG] ${cleanLog}`);
                const lines = cleanLog.split('\n');
                progress.report({ message: lines[lines.length - 1].substring(0, 80) });
            }
        });

        const timer = setInterval(async () => {
            const inspect = await exec.inspect();
            if (!inspect.Running) {
                clearInterval(timer);
                if (inspect.ExitCode !== 0) reject(new Error(`SqlPackage failed (${inspect.ExitCode})`));
                else resolve();
            }
        }, 500);
    });
}

async function findSqlCmd(container) {
    const paths = ['/opt/mssql-tools18/bin/sqlcmd', '/opt/mssql-tools/bin/sqlcmd', '/usr/local/bin/sqlcmd', '/usr/bin/sqlcmd'];
    for (const path of paths) { if (await checkFileExists(container, path)) return path; }
    return null;
}

async function findSqlPackage(container) {
    const paths = ['/opt/sqlpackage/sqlpackage', '/usr/local/bin/sqlpackage', '/tmp/sqlpackage/sqlpackage'];
    for (const path of paths) { if (await checkFileExists(container, path)) return path; }
    return null;
}

async function checkFileExists(container, path) {
    try {
        const exec = await container.exec({ Cmd: ['test', '-f', path] });
        const inspect = await runExecInternal(exec);
        return inspect.ExitCode === 0;
    } catch (e) { return false; }
}

async function runExecInternal(exec) {
    await exec.start();
    return new Promise(resolve => {
        const timer = setInterval(async () => {
            const inspect = await exec.inspect();
            if (!inspect.Running) {
                clearInterval(timer);
                resolve(inspect);
            }
        }, 100);
    });
}

async function installSqlPackage(container, containerName) {
    const osInfo = await getOsInfo(container);
    const pkgUrl = "https://aka.ms/sqlpackage-linux";
    let command = osInfo.includes('alpine') 
        ? `apk add --no-cache wget unzip libicu icu-libs krb5-libs libgcc libintl libssl1.1 libstdc++ zlib && wget -O /tmp/sqlpackage.zip ${pkgUrl} && mkdir -p /tmp/sqlpackage && unzip /tmp/sqlpackage.zip -d /tmp/sqlpackage && chmod +x /tmp/sqlpackage/sqlpackage`
        : `apt-get update && apt-get install -y wget unzip libicu-dev && wget -O /tmp/sqlpackage.zip ${pkgUrl} && mkdir -p /tmp/sqlpackage && unzip /tmp/sqlpackage.zip -d /tmp/sqlpackage && chmod +x /tmp/sqlpackage/sqlpackage`;
    const exec = await container.exec({ Cmd: ['sh', '-c', command], User: 'root' });
    await runExecInternal(exec);
    return '/tmp/sqlpackage/sqlpackage';
}

async function getOsInfo(container) {
    try {
        const exec = await container.exec({ Cmd: ['cat', '/etc/os-release'], AttachStdout: true });
        const stream = await exec.start();
        return new Promise(resolve => {
            let output = '';
            stream.on('data', chunk => {
                let offset = 0;
                while (offset < chunk.length) {
                    const length = chunk.readUInt32BE(offset + 4);
                    output += chunk.slice(offset + 8, offset + 8 + length).toString('utf8');
                    offset += 8 + length;
                }
            });
            stream.on('end', () => resolve(output.toLowerCase()));
        });
    } catch (e) { return 'debian'; }
}

function deactivate() {}
module.exports = { activate, deactivate };