import bcrypt from 'bcryptjs';

// Usage: npm run hash -- "your admin password"
const pw = process.argv[2];
if (!pw) {
  console.error('Usage: npm run hash -- "your password"');
  process.exit(1);
}
console.log(bcrypt.hashSync(pw, 12));
