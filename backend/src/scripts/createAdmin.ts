import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline';
import { config } from '../config.js';
import { prisma } from '../db.js';

/** Creates (or promotes) the platform administrator. The password is typed hidden and never printed. */
function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Mute echo while the password is typed.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stdout.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const email = (await ask('Admin email: ')).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('That does not look like an email address.');
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { isPlatformAdmin: true } });
    console.log(`${email} already had an account and is now a platform admin.`);
    return;
  }
  const name = (await ask('Your name: ')) || 'Platform admin';
  const password = await ask('Password (min 10 characters, hidden): ', true);
  if (password.length < 10) throw new Error('Password must be at least 10 characters.');
  const again = await ask('Type the password again: ', true);
  if (again !== password) throw new Error('The two passwords did not match.');

  const tenant = await prisma.tenant.create({ data: { name: 'Platform' } });
  await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: await bcrypt.hash(password, config.bcryptCost),
      role: 'OWNER',
      isPlatformAdmin: true,
      tenantId: tenant.id,
    },
  });
  console.log(`Platform admin ${email} created. Sign in, then open "Platform setup" to save the Connected App details.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
