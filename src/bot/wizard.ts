import { registerApp } from '@larksuiteoapi/node-sdk';
import qrcode from 'qrcode-terminal';
import type { AppConfig, TenantBrand } from '../config/schema';

/**
 * Scan-QR onboarding: creates/selects a PersonalAgent app via the Lark SDK's
 * registerApp flow and returns a config with the app credentials. The QR
 * scanner's open_id is seeded as the sole admin (design §5: admins default =
 * owner). Returns a config whose `secret` is the plaintext client_secret;
 * the caller moves it into the keystore.
 */
export async function runRegistrationWizard(): Promise<AppConfig> {
  console.log('\n未检测到飞书应用配置，进入扫码创建向导。\n');

  const result = await registerApp({
    onQRCodeReady: (info) => {
      console.log('请用飞书 App 扫描以下二维码完成应用创建：\n');
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n二维码有效期：约 ${mins} 分钟`);
      console.log(`也可以直接在浏览器打开：${info.url}\n`);
    },
    onStatusChange: (info) => {
      if (info.status === 'domain_switched') {
        console.log('识别到国际版租户，已切换到 larksuite.com 域名。');
      } else if (info.status === 'slow_down') {
        console.log('轮询速度过快，已自动降速。');
      }
    },
  });

  const tenant: TenantBrand = result.user_info?.tenant_brand ?? 'feishu';
  const operatorOpenId = result.user_info?.open_id;

  console.log('\n✓ 应用创建成功');
  console.log(`  App ID:  ${result.client_id}`);
  console.log(`  Tenant:  ${tenant}`);

  const cfg: AppConfig = {
    accounts: { app: { id: result.client_id, secret: result.client_secret, tenant } },
  };

  if (operatorOpenId) {
    cfg.preferences = { access: { admins: [operatorOpenId] } };
    console.log(`  Admin:   ${operatorOpenId} (你自己，已自动加入管理员名单)`);
  } else {
    console.log(
      '  ⚠️ 未拿到扫码用户的 open_id；管理员列表留空 = 所有用户都能私聊建项目。\n' +
        '     可稍后在 /config 手动设置管理员。',
    );
  }
  console.log('');
  return cfg;
}
