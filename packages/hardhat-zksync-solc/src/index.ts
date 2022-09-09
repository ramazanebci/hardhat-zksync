import {
    TASK_COMPILE_SOLIDITY_RUN_SOLC,
    TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS,
    TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT,
    TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
    TASK_COMPILE_SOLIDITY_COMPILE_JOBS,
} from 'hardhat/builtin-tasks/task-names';
import { SolcBuild } from 'hardhat/types';
import { CompilationJob } from 'hardhat/internal/solidity/compilation-job';
import { extendEnvironment, extendConfig, subtask } from 'hardhat/internal/core/config/config-env';
import './type-extensions';
import { FactoryDeps, ZkSolcConfig } from './types';
import { Artifacts, getArtifactFromContractOutput } from 'hardhat/internal/artifacts';
import { compile } from './compile';
import { zeroxlify, pluginError, getZksolcPath, getZksolcUrl } from './utils';
import { spawnSync } from 'child_process';
import { download } from 'hardhat/internal/util/download';
import fs from 'fs';

const ZK_ARTIFACT_FORMAT_VERSION = 'hh-zksolc-artifact-1';
const LATEST_VERSION = '1.1.6';

extendConfig((config, userConfig) => {
    const defaultConfig: ZkSolcConfig = {
        version: LATEST_VERSION,
        compilerSource: 'binary',
        settings: {
            compilerPath: '',
            experimental: {},
        },
    };

    if (userConfig?.zksolc?.settings?.optimizer) {
        console.warn('`optimizer` setting is deprecated, optimizer is always enabled');
    }

    config.zksolc = { ...defaultConfig, ...userConfig?.zksolc };
    config.zksolc.settings = { ...defaultConfig.settings, ...userConfig?.zksolc?.settings };
});

extendEnvironment((hre) => {
    if (hre.network.config.zksync) {
        hre.network.zksync = hre.network.config.zksync;

        let artifactsPath = hre.config.paths.artifacts;
        if (!artifactsPath.endsWith('-zk')) {
            artifactsPath = artifactsPath + '-zk';
        }

        let cachePath = hre.config.paths.cache;
        if (!cachePath.endsWith('-zk')) {
            cachePath = cachePath + '-zk';
        }

        // Forcibly update the artifacts object.
        hre.config.paths.artifacts = artifactsPath;
        hre.config.paths.cache = cachePath;
        (hre as any).artifacts = new Artifacts(artifactsPath);

        // If solidity optimizer is not enabled, the libraries are not inlined and
        // we have to manually pass them into zksolc. That's why we force the optimization.
        hre.config.solidity.compilers.forEach((compiler) => {
            let settings = compiler.settings || {};
            compiler.settings = { ...settings, optimizer: { enabled: true } };
        });
    }
});

// This override is needed to invalidate cache when zksolc config is changed
// (e.g. version, compilerSource, settings), as well as save the correct solc
// versions in build-info files when using docker.
subtask(
    TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS,
    async (
        args: {
            output: any;
            compilationJob: CompilationJob;
            solcBuild: SolcBuild;
        },
        hre,
        runSuper
    ) => {
        // @ts-ignore
        args.compilationJob.solidityConfig.zksolcConfig = hre.config.zksolc;
        if (hre.config.zksolc.compilerSource === 'docker') {
            args.compilationJob.solidityConfig.version = args.output.version ?? 'unknown';
            args.solcBuild.longVersion = args.output.long_version ?? args.output.version ?? 'unknown';
        }
        return await runSuper(args);
    }
);

subtask(
    TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT,
    async (
        {
            sourceName,
            contractName,
            contractOutput,
        }: {
            sourceName: string;
            contractName: string;
            contractOutput: any;
        },
        hre
    ): Promise<any> => {
        if (hre.network.zksync !== true) {
            return getArtifactFromContractOutput(sourceName, contractName, contractOutput);
        }
        let bytecode: string =
            contractOutput.evm?.bytecode?.object || contractOutput.evm?.deployedBytecode?.object || '';
        bytecode = zeroxlify(bytecode);

        let factoryDeps: FactoryDeps = {};
        let entries: Array<[string, string]> = Object.entries(contractOutput.factoryDependencies || {});
        for (const [hash, dependency] of entries) {
            factoryDeps[zeroxlify(hash)] = dependency;
        }

        return {
            _format: ZK_ARTIFACT_FORMAT_VERSION,
            contractName,
            sourceName,
            abi: contractOutput.abi,
            // technically, zkEVM has no difference between bytecode & deployedBytecode,
            // but both fields are included just in case
            bytecode,
            deployedBytecode: bytecode,
            // zksolc does not support unlinked objects,
            // all external libraries are either linked during compilation or inlined
            linkReferences: {},
            deployedLinkReferences: {},

            // zkSync-specific field
            factoryDeps,
        };
    }
);

subtask(TASK_COMPILE_SOLIDITY_RUN_SOLC, async (args: { input: any; solcPath: string }, hre, runSuper) => {
    if (hre.network.zksync !== true) {
        return await runSuper(args);
    }

    if (hre.config.zksolc.settings.libraries) {
        args.input.settings.libraries = hre.config.zksolc.settings.libraries;
    }

    return await compile(hre.config.zksolc, args.input, args.solcPath);
});

// This task is overriden to:
// - prevent unnecessary solc downloads when using docker
// - download zksolc binary if needed
// - validate zksolc binary
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: { solcVersion: string }, hre, runSuper) => {
    if (hre.network.zksync !== true) {
        return await runSuper(args);
    }

    if (hre.config.zksolc.compilerSource === 'docker') {
        // `version` and `longVersion` later overriden by actual solc version used in docker
        // and saved to cache and build-info files.
        return {
            compilerPath: '',
            isSolsJs: false,
            version: args.solcVersion,
            longVersion: args.solcVersion,
        };
    }

    const solcBuild = await runSuper(args);
    let compilerPath = hre.config.zksolc.settings.compilerPath;

    if (compilerPath) {
        const versionOutput = spawnSync(compilerPath, ['--version']);
        const version = versionOutput.stdout?.toString().match(/\d+\.\d+\.\d+/)?.toString();

        if (versionOutput.status !== 0 || version == null) {
            throw pluginError(`Specified zksolc binary is not found or invalid`);
        }
    } else {
        compilerPath = await getZksolcPath(hre.config.zksolc.version);
        if (!fs.existsSync(compilerPath)) {
            console.log(`Downloading zksolc ${hre.config.zksolc.version}`);
            try {
                await download(getZksolcUrl(hre.config.zksolc.version), compilerPath);
                fs.chmodSync(compilerPath, '755');
                console.log('Done.');
            } catch (e: any) {
                throw pluginError(e.message.split('\n')[0]);
            }
        }
    }

    return solcBuild;
});
