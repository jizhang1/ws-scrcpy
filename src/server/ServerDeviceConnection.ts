// @ts-ignore
import ADB from 'adbkit';
// @ts-ignore
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as path from 'path';
import { Device } from '../common/Device';
import { AdbKitChangesSet, AdbKitClient, AdbKitDevice, AdbKitTracker, PushTransfer } from '../common/AdbKit';
import { SERVER_PACKAGE, SERVER_PORT, SERVER_VERSION } from './Constants';

const TEMP_PATH = '/data/local/tmp/';
const FILE_DIR = path.join(__dirname, '../public');
const FILE_NAME = 'scrcpy-server.jar';
const ARGS = `/ ${SERVER_PACKAGE} ${SERVER_VERSION} 0 8000000 60 -1 false - false false 0 web ${SERVER_PORT} 2>&1 > /dev/null`;

const GET_SHELL_PROCESSES = 'find /proc -type d -maxdepth 1 -user $UID -group $GID 2>/dev/null';
const CHECK_CMDLINE = `test -f "$a/cmdline" && grep -av find "$a/cmdline" |grep -sae app_process.*${SERVER_PACKAGE} |grep ${SERVER_VERSION} 2>&1 > /dev/null && echo $a |cut -d "/" -f 3;`;
const CMD = 'UID=`id -nu`; GID=`id -ng`; for a in `' + GET_SHELL_PROCESSES + '`; do ' + CHECK_CMDLINE + ' done; exit 0';

export class ServerDeviceConnection extends EventEmitter {
    public static readonly UPDATE_EVENT: string = 'update';
    private static instance: ServerDeviceConnection;
    private pendingUpdate: boolean = false;
    private cache: Device[] = [];
    private deviceMap: Map<string, Device> = new Map();
    private clientMap: Map<string, AdbKitClient> = new Map();
    private forwardDeviceMap: Map<string, string | undefined> = new Map();
    private forwardDevicePort: string[] = ['8886', '8896', '8906', '8916', '8926'];
    private client: AdbKitClient = ADB.createClient();
    private tracker?: AdbKitTracker;
    private initialized: boolean = false;
    public static getInstance(): ServerDeviceConnection {
        if (!this.instance) {
            this.instance = new ServerDeviceConnection();
        }
        return this.instance;
    }
    constructor() {
        super();
    }

    public async init(): Promise<void> {
        if (this.initialized) {
            return;
        }
        await this.initTracker();
        this.initialized = true;
    }

    private async initTracker(): Promise<AdbKitTracker> {
        if (this.tracker) {
            return this.tracker;
        }
        const tracker = this.tracker = await this.client.trackDevices();
        if (tracker.deviceList && tracker.deviceList.length) {
            this.cache = await this.mapDevicesToDescriptors(tracker.deviceList);
        }
        tracker.on('changeSet', async (changes: AdbKitChangesSet) => {
            if (changes.added.length) {
                for (const device of changes.added) {
                    const descriptor = await this.getDescriptor(device);
                    this.deviceMap.set(device.id, descriptor);
                }
            }
            if (changes.removed.length) {
                for (const device of changes.removed) {
                    const udid = device.id;
                    if (this.deviceMap.has(udid)) {
                        this.deviceMap.delete(udid);
                    }
                    if (this.clientMap.has(device.id)) {
                        this.clientMap.delete(device.id);
                    }
                    this.forwardRemove(udid);
                }
            }
            if (changes.changed.length) {
                for (const device of changes.changed) {
                    const udid = device.id;
                    const descriptor = await this.getDescriptor(device);
                    this.deviceMap.set(udid, descriptor);
                    if (this.clientMap.has(udid)) {
                        this.clientMap.delete(udid);
                    }
                }
            }
            this.cache = Array.from(this.deviceMap.values());
            this.emit(ServerDeviceConnection.UPDATE_EVENT, this.cache);
        });
        return tracker;
    }

    private async mapDevicesToDescriptors(list: AdbKitDevice[]): Promise<Device[]> {
        const all = await Promise.all(list.map(device => this.getDescriptor(device)));
        list.forEach((device: AdbKitDevice, idx: number) => {this.deviceMap.set(device.id, all[idx]);});
        return all;
    }

    private getOrCreateClient(udid: string): AdbKitClient {
        let client: AdbKitClient | undefined;
        if (this.clientMap.has(udid)) {
            client = this.clientMap.get(udid);
        }
        if (!client) {
            client = ADB.createClient() as AdbKitClient;
            this.clientMap.set(udid, client);
        }
        return client;
    }

    private async getDescriptor(device: AdbKitDevice): Promise<Device> {
        const {id: udid, type: state} = device;
        if (state === 'offline') {
            return {
                'build.version.release': '',
                'build.version.sdk': '',
                'ro.product.cpu.abi': '',
                'product.manufacturer': '',
                'product.model': '',
                pid: -1,
                ip: '0.0.0.0',
                port: '8886',
                state,
                udid
            };
        }
        const client = this.getOrCreateClient(udid);
        await client.waitBootComplete(udid);
        const props = await client.getProperties(udid);
        const wifi = props['wifi.interface'];
        const descriptor: Device = {
            pid: -1,
            ip: '127.0.0.1',
            port: '8886',
            'ro.product.cpu.abi': props['ro.product.cpu.abi'],
            'product.manufacturer': props['ro.product.manufacturer'],
            'product.model': props['ro.product.model'],
            'build.version.release': props['ro.build.version.release'],
            'build.version.sdk': props['ro.build.version.sdk'],
            state,
            udid
        };
        try {
            const stream = await client.shell(udid, `ip route |grep ${wifi} |grep -v default`);
            const buffer = await ADB.util.readAll(stream);
            const temp = buffer.toString().split(' ').filter((i: string) => !!i);
            descriptor.ip = temp[8];
            if (!descriptor.ip) {
                descriptor.ip = '127.0.0.1';
                descriptor.port = await this.forwardDevice(descriptor.udid);
            }
            let pid = await this.getPID(device);
            let count = 0;
            if (isNaN(pid)) {
                await this.copyServer(device);
            }
            while (isNaN(pid) && count < 5) {
                this.spawnServer(device);
                pid = await this.getPID(device);
                count++;
            }
            if (isNaN(pid)) {
                console.error(`[${udid}] error: failed to start server`);
                descriptor.pid = -1;
            } else {
                descriptor.pid = pid;
            }
        } catch (e) {
            console.error(`[${udid}] error: ${e.message}`);
        }
        return descriptor;
    }

    private async forwardDevice(udid: string): Promise<string> {
        const client = this.getOrCreateClient(udid);
        await client.waitBootComplete(udid);

        let fwdPort = this.forwardDeviceMap.get(udid);
        if (!fwdPort) {
            fwdPort = this.forwardDevicePort.shift() || '8886';
        }
        try {
            await client.forward(udid, 'tcp:' + fwdPort, 'tcp:8886');
            this.forwardDeviceMap.set(udid, fwdPort);
        } catch (e) {
            console.error(`[${udid}] error: ${e.message}`);
        }
        return fwdPort;
    }

    private async forwardRemove(udid: string): Promise<void> {
        let fwdPort = this.forwardDeviceMap.get(udid);
        if(fwdPort) {
            this.forwardDevicePort.push(fwdPort);
            this.forwardDeviceMap.delete(udid);
        }
    }

    private async getPID(device: AdbKitDevice): Promise<number> {
        const {id: udid} = device;
        const client = this.getOrCreateClient(udid);
        await client.waitBootComplete(udid);
        const stream = await client.shell(udid, CMD);
        const buffer = await ADB.util.readAll(stream);
        const shellProcessesArray = buffer.toString().split('\n').filter((pid: string) => pid.trim().length);
        if (!shellProcessesArray.length) {
            return NaN;
        }
        return parseInt(shellProcessesArray[0], 10);
    }

    private async copyServer(device: AdbKitDevice): Promise<PushTransfer> {
        const {id: udid} = device;
        const client = this.getOrCreateClient(udid);
        await client.waitBootComplete(udid); const src = path.join(FILE_DIR, FILE_NAME);
        const dst = TEMP_PATH + FILE_NAME; // don't use path.join(): will not work on win host
        return client.push(udid, src, dst);
    }

    private spawnServer(device: AdbKitDevice): void {
        const {id: udid} = device;
        const command = `CLASSPATH=${TEMP_PATH}${FILE_NAME} nohup app_process ${ARGS}`;
        const adb = spawn('adb', ['-s', `${udid}`, 'shell', command], { stdio: ['ignore', 'pipe', 'pipe'] });

        adb.stdout.on('data', data => {
            console.log(`[${udid}] stdout: ${data}`);
        });

        adb.stderr.on('data', data => {
            console.error(`[${udid}] stderr: ${data}`);
        });

        adb.on('close', code => {
            console.log(`[${udid}] adb process exited with code ${code}`);
        });
    }

    private updateDeviceList(): void {
        if (this.pendingUpdate) {
            return;
        }
        this.pendingUpdate = true;
        const anyway = () => {
            this.pendingUpdate = false;
        };
        this.initTracker()
            .then(tracker => {
                if (tracker && tracker.deviceList && tracker.deviceList.length) {
                    return this.mapDevicesToDescriptors(tracker.deviceList);
                }
                return [] as Device[];
            })
            .then(list => {
                this.cache = list;
                this.emit(ServerDeviceConnection.UPDATE_EVENT, this.cache);
            })
            .then(anyway, anyway);
    }

    public getDevices(): Device[] {
        this.updateDeviceList();
        return this.cache;
    }
}
