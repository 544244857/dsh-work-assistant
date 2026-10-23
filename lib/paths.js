import { homedir } from 'node:os';
import { join } from 'node:path';

// DSH_HOME 优先，其次 ~/.dsh，与其它 dsh 插件保持一致
export function defaultStateRoot() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function stateDir(config = {}) {
  const custom = typeof config.stateDir === 'string' ? config.stateDir.trim() : '';
  return custom || join(defaultStateRoot(), 'dsh-work-assistant');
}

export function dataPaths(dir) {
  return {
    dir,
    // 结构化数据全在这一个 SQLite 库里：工作项、副手、知识库、消息、人物关系、设置
    db: join(dir, 'work-assistant.db'),
    // 下面几个是老 JSON 时代的路径，只留着做一次性迁移读入，不再往里写
    state: join(dir, 'state.json'),
    ledger: join(dir, 'ledger.json'),
    assignments: join(dir, 'assignments.json'),
    kbDir: join(dir, 'kb'),
    kbIndex: join(dir, 'kb', 'index.json'),
    // 微信发来的图片和文件落在这里；助手产出的文件也先写这儿再发出去
    mediaDir: join(dir, 'media'),
    log: join(dir, 'gateway.log'),
  };
}
