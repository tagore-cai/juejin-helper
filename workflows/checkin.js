import notification from "./utils/notification-kit";
const JuejinHelper = require("juejin-helper");
const utils = require("./utils/utils");
const env = require("./utils/env");

/**
 * 掘金已对部分接口(check_in / lottery_config/get / lottery/draw)启用风控,
 * 直接请求会返回空响应。需要在真实浏览器页面内发起请求,
 * 由页面内的风控SDK(bdms)自动附加 msToken / a_bogus 等签名参数。
 */

/**
 * 解析 __tea_cookie_tokens_* 中的 aid/uuid
 * (npm 包 juejin-helper 1.7.2 内置的 parseCookieTokens 存在编译缺陷, 始终返回空值)
 */
function getCookieTokens(cookie) {
  const tokens = { aid: "", uuid: "", user_unique_id: "", web_id: "" };
  const tokensReg = /^__tea_cookie_tokens_(\d+)$/;
  for (const [key, value] of cookie.split("; ").map(item => item.split("="))) {
    if (tokensReg.test(key)) {
      tokens.aid = key.match(tokensReg)[1];
      const json = JSON.parse(decodeURIComponent(decodeURIComponent(value)));
      tokens.uuid = json.user_unique_id;
      tokens.user_unique_id = json.user_unique_id;
      tokens.web_id = json.web_id;
      break;
    }
  }
  return tokens;
}

async function requestWithRiskControl(page, juejin, path, { method = "POST", body } = {}) {
  const tokens = getCookieTokens(juejin.getCookie());
  if (!tokens || !tokens.aid || !tokens.uuid) {
    throw new Error("Cookie中缺少 __tea_cookie_tokens_* 参数, 请重新获取Cookie");
  }
  const url = `https://api.juejin.cn${path}?aid=${tokens.aid}&uuid=${tokens.uuid}`;

  // 注意: 回调内不能使用 async/await, ts-node 会将其编译为依赖 __awaiter 的 ES5 代码,
  // 而 __awaiter 在浏览器页面上下文中不存在
  return page.evaluate(
    ({ url, method, body }) => {
      const waitFor = (fn, timeout = 20000) =>
        new Promise((resolve, reject) => {
          const start = Date.now();
          const timer = setInterval(() => {
            if (fn()) {
              clearInterval(timer);
              resolve();
            } else if (Date.now() - start > timeout) {
              clearInterval(timer);
              reject(new Error("风控SDK加载超时"));
            }
          }, 200);
        });

      return waitFor(() => !!window.bdms).then(() => {
        const request = fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: "include"
        })
          .then(response => response.text())
          .then(text => (text ? JSON.parse(text) : null));

        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("请求超时")), 30000));
        return Promise.race([request, timeout]);
      });
    },
    { url, method, body }
  );
}

async function checkInWithRiskControl(page, juejin) {
  const result = await requestWithRiskControl(page, juejin, "/growth_api/v1/check_in", { method: "POST", body: {} });
  if (result && result.err_no) {
    throw new Error(result.err_msg);
  }
  return result && result.data;
}

class Task {
  constructor(juejin) {
    this.juejin = juejin;
  }

  taskName = "";

  async run() {}

  toString() {
    return `[${this.taskName}]`;
  }
}

class GrowthTask extends Task {
  taskName = "成长任务";

  todayStatus = 0; // 未签到
  incrPoint = 0;
  sumPoint = 0; // 当前矿石数
  contCount = 0; // 连续签到天数
  sumCount = 0; // 累计签到天数

  async run(page) {
    const growth = this.juejin.growth();

    const todayStatus = await growth.getTodayStatus();
    if (!todayStatus) {
      const checkInResult = await checkInWithRiskControl(page, this.juejin);

      this.incrPoint = checkInResult.incr_point;
      this.sumPoint = checkInResult.sum_point;
      this.todayStatus = 1; // 本次签到
    } else {
      this.todayStatus = 2; // 已签到
    }

    const counts = await growth.getCounts();
    this.contCount = counts.cont_count;
    this.sumCount = counts.sum_count;
  }
}

class DipLuckyTask extends Task {
  taskName = "沾喜气";

  dipStatus = -1;
  dipValue = 0;
  luckyValue = 0;

  async run() {
    const growth = this.juejin.growth();

    // 掘金沾喜气功能已停用！
    // const luckyusersResult = await growth.getLotteriesLuckyUsers();
    // if (luckyusersResult.count > 0) {
    //   const no1LuckyUser = luckyusersResult.lotteries[0];
    //   const dipLuckyResult = await growth.dipLucky(no1LuckyUser.history_id);
    //   if (dipLuckyResult.has_dip) {
    //     this.dipStatus = 2;
    //   } else {
    //     this.dipStatus = 1;
    //     this.dipValue = dipLuckyResult.dip_value;
    //   }
    // }

    const luckyResult = await growth.getMyLucky();
    this.luckyValue = luckyResult.total_value;
  }
}

class BugfixTask extends Task {
  taskName = "Bugfix";

  bugStatus = -1;
  collectBugCount = 0;
  userOwnBug = 0;

  async run() {
    const bugfix = this.juejin.bugfix();

    const competition = await bugfix.getCompetition();
    const bugfixInfo = await bugfix.getUser(competition);
    this.userOwnBug = bugfixInfo.user_own_bug;

    // 掘金Bugfix功能已停用。
    // try {
    //   const notCollectBugList = await bugfix.getNotCollectBugList();
    //   await bugfix.collectBugBatch(notCollectBugList);
    //   this.bugStatus = 1;
    //   this.collectBugCount = notCollectBugList.length;
    //   this.userOwnBug += this.collectBugCount;
    // } catch (e) {
    //   this.bugStatus = 2;
    // }
  }
}

class LotteriesTask extends Task {
  taskName = "抽奖";

  lottery = []; // 奖池
  pointCost = 0; // 一次抽奖消耗
  freeCount = 0; // 免费抽奖次数
  drawLotteryHistory = {};
  lotteryCount = 0;
  luckyValueProbability = 0;

  async run(growthTask, dipLuckyTask, page) {
    const growth = this.juejin.growth();

    const lotteryConfigResult = await requestWithRiskControl(page, this.juejin, "/growth_api/v1/lottery_config/get", {
      method: "GET"
    });
    if (lotteryConfigResult && lotteryConfigResult.err_no) {
      throw new Error(lotteryConfigResult.err_msg);
    }
    const lotteryConfig = lotteryConfigResult && lotteryConfigResult.data;
    this.lottery = lotteryConfig.lottery;
    this.pointCost = lotteryConfig.point_cost;
    this.freeCount = lotteryConfig.free_count;
    this.lotteryCount = 0;

    let freeCount = this.freeCount;
    while (freeCount > 0) {
      const drawResult = await requestWithRiskControl(page, this.juejin, "/growth_api/v1/lottery/draw", {
        method: "POST",
        body: {}
      });
      if (drawResult && drawResult.err_no) {
        throw new Error(drawResult.err_msg);
      }
      const result = drawResult && drawResult.data;
      this.drawLotteryHistory[result.lottery_id] = (this.drawLotteryHistory[result.lottery_id] || 0) + 1;
      dipLuckyTask.luckyValue = result.total_lucky_value;
      freeCount--;
      this.lotteryCount++;
      await utils.wait(utils.randomRangeNumber(300, 1000));
    }

    growthTask.sumPoint = await growth.getCurrentPoint();

    const getProbabilityOfWinning = sumPoint => {
      const pointCost = this.pointCost;
      const luckyValueCost = 10;
      const totalDrawsNumber = sumPoint / pointCost;
      let supplyPoint = 0;
      for (let i = 0, length = Math.floor(totalDrawsNumber * 0.65); i < length; i++) {
        supplyPoint += Math.ceil(Math.random() * 100);
      }
      const luckyValue = ((sumPoint + supplyPoint) / pointCost) * luckyValueCost + dipLuckyTask.luckyValue;
      return luckyValue / 6000;
    };

    this.luckyValueProbability = getProbabilityOfWinning(growthTask.sumPoint);
  }
}

class SdkTask extends Task {
  taskName = "埋点";

  calledSdkSetting = false;
  calledTrackGrowthEvent = false;
  calledTrackOnloadEvent = false;

  async run() {
    console.log("------事件埋点追踪-------");

    const sdk = this.juejin.sdk();

    try {
      await sdk.slardarSDKSetting();
      this.calledSdkSetting = true;
    } catch {
      this.calledSdkSetting = false;
    }
    console.log(`SDK状态: ${this.calledSdkSetting ? "加载成功" : "加载失败"}`);

    try {
      const result = await sdk.mockTrackGrowthEvent();
      if (result && result.e === 0) {
        this.calledTrackGrowthEvent = true;
      } else {
        throw result;
      }
    } catch {
      this.calledTrackGrowthEvent = false;
    }
    console.log(`成长API事件埋点: ${this.calledTrackGrowthEvent ? "调用成功" : "调用失败"}`);

    try {
      const result = await sdk.mockTrackOnloadEvent();
      if (result && result.e === 0) {
        this.calledTrackOnloadEvent = true;
      } else {
        throw result;
      }
    } catch {
      this.calledTrackOnloadEvent = false;
    }
    console.log(`OnLoad事件埋点: ${this.calledTrackOnloadEvent ? "调用成功" : "调用失败"}`);

    console.log("-------------------------");
  }
}

class MockVisitTask extends Task {
  taskName = "模拟访问";

  async run() {
    console.log("--------模拟访问---------");
    try {
      const browser = this.juejin.browser();
      await browser.open();
      try {
        await browser.visitPage("/");
        console.log("掘金首页：页面访问成功");
      } catch (e) {
        console.log("掘金首页：页面访问失败");
      }
      await utils.wait(utils.randomRangeNumber(2000, 5000));
      try {
        await browser.visitPage("/user/center/signin");
        console.log("掘金每日签到：页面访问成功");
      } catch (e) {
        console.log("掘金每日签到：页面访问失败");
      }
      await utils.wait(utils.randomRangeNumber(2000, 5000));
      await browser.close();
    } catch {
      console.log("浏览器API异常");
    }
    console.log("-------------------------");
  }
}

class CheckIn {
  cookie = "";
  username = "";

  constructor(cookie) {
    this.cookie = cookie;
  }

  async run() {
    const juejin = new JuejinHelper();
    try {
      await juejin.login(this.cookie);
    } catch (e) {
      console.error("登录失败, 请尝试更新Cookies! " + e.message);
      return -1;
    }

    this.username = juejin.getUser().user_name;

    this.growthTask = new GrowthTask(juejin);
    this.dipLuckyTask = new DipLuckyTask(juejin);
    this.lotteriesTask = new LotteriesTask(juejin);
    this.bugfixTask = new BugfixTask(juejin);
    this.sdkTask = new SdkTask(juejin);
    this.mockVisitTask = new MockVisitTask(juejin);

    await this.mockVisitTask.run();
    await this.sdkTask.run();

    const browser = juejin.browser();
    await browser.open({ args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.visitPage("/");

    try {
      console.log(`运行 ${this.growthTask.taskName}`);
      await this.growthTask.run(page);
      console.log(`运行 ${this.dipLuckyTask.taskName}`);
      await this.dipLuckyTask.run();
      console.log(`运行 ${this.lotteriesTask.taskName}`);
      await this.lotteriesTask.run(this.growthTask, this.dipLuckyTask, page);
      console.log(`运行 ${this.bugfixTask.taskName}`);
      await this.bugfixTask.run();
    } finally {
      await browser.close();
    }
    await juejin.logout();
    console.log("-------------------------");

    return this.growthTask.todayStatus;
  }

  toString() {
    if (!this.username) {
      return "登录失败，请检查Cookies是否正确！";
    }
    const drawLotteryHistory = Object.entries(this.lotteriesTask.drawLotteryHistory)
      .map(([lottery_id, count]) => {
        const lotteryItem = this.lotteriesTask.lottery.find(item => item.lottery_id === lottery_id);
        if (lotteryItem) {
          return `${lotteryItem.lottery_name}: ${count}`;
        }
        return `${lottery_id}: ${count}`;
      })
      .join("\n");

    return `
掘友: ${this.username}
${
  {
    0: "签到失败",
    1: `签到成功 +${this.growthTask.incrPoint} 矿石`,
    2: "今日已完成签到"
  }[this.growthTask.todayStatus]
  // ${
  //   {
  //     "-1": "沾喜气已停用",
  //     0: "沾喜气失败",
  //     1: `沾喜气 +${this.dipLuckyTask.dipValue} 幸运值`,
  //     2: "今日已经沾过喜气"
  //   }[this.dipLuckyTask.dipStatus]
  // }
  // ${
  //   this.bugfixTask.bugStatus === 1
  //     ? this.bugfixTask.collectBugCount > 0
  //       ? `收集Bug +${this.bugfixTask.collectBugCount}`
  //       : "没有可收集Bug"
  //     : "收集Bug失败"
  // }
}
连续签到天数 ${this.growthTask.contCount}
累计签到天数 ${this.growthTask.sumCount}
当前矿石数 ${this.growthTask.sumPoint}
当前未消除Bug数量 ${this.bugfixTask.userOwnBug}
当前幸运值 ${this.dipLuckyTask.luckyValue}/6000
预测All In矿石累计幸运值比率 ${(this.lotteriesTask.luckyValueProbability * 100).toFixed(2) + "%"}
抽奖总次数 ${this.lotteriesTask.lotteryCount}
免费抽奖次数 ${this.lotteriesTask.freeCount}
${this.lotteriesTask.lotteryCount > 0 ? "==============\n" + drawLotteryHistory + "\n==============" : ""}
`.trim();
  }
}

async function run(args) {
  const cookies = utils.getUsersCookie(env);
  let messageList = [];
  let hasError = false;

  for (let cookie of cookies) {
    const checkin = new CheckIn(cookie);

    await utils.wait(utils.randomRangeNumber(1000, 5000));
    const status = await checkin.run();

    const content = checkin.toString();
    console.log(content);

    if (status === -1) {
      hasError = true;
    }

    messageList.push(content);
  }

  const message = messageList.join(`\n${"-".repeat(15)}\n`);

  notification.pushMessage({
    title: "掘金每日签到",
    content: hasError ? `<strong>登录失败提醒</strong><pre>${message}</pre>` : message,
    msgtype: hasError ? "html" : "text"
  });
}

// 移除 catch 块中的 throw error
run(process.argv.splice(2)).catch(error => {
  console.error("Error: ", error);
  notification.pushMessage({
    title: "掘金每日签到",
    content: `<strong>Error</strong><pre>${error.message}</pre>`,
    msgtype: "html"
  });
});
