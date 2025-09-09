import * as bcrypt from 'bcryptjs';

export const encodePassword = (password: string): string => {
  const salt = bcrypt.genSaltSync();
  return bcrypt.hashSync(password, salt);
};

export const comparePassword = async (password: string, hashPassword: string): Promise<boolean> => {
  return bcrypt.compare(password, hashPassword);
};

export const encoder = (value: string): string => {
  const salt = bcrypt.genSaltSync();
  return bcrypt.hashSync(value, salt);
};
