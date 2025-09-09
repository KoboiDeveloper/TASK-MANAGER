import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private transporter = nodemailer.createTransport({
    service: process.env.SERVICE_MAIL,
    auth: {
      user: process.env.SENDER_MAIL,
      pass: process.env.PASS_APP,
    },
  });
  domain: string = process.env.DOMAIN || 'http://localhost:3000';
  async sendResetPasswordEmail(to: string, token: string, otp: string): Promise<void> {
    const resetUrl = `${this.domain}/reset-password?verifylink=${token}`;

    const htmlContent = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
    <div style="background-color: #4f46e5; padding: 20px; color: white;">
      <h2 style="margin: 0;">🔐 Reset Password</h2>
    </div>
    <div style="padding: 20px;">
      <p>Hi, We received a request to reset your password. Use the OTP below or click the button to proceed:</p>

      <div style="background-color: #f4f4f4; padding: 16px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 2px; border-radius: 6px; margin: 16px 0;">
        ${otp}
      </div>

      <div style="text-align: center; margin: 24px 0;">
        <a href="${resetUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Reset Password
        </a>
      </div>

      <p>This OTP and link will expire in <strong>15 minutes</strong>.</p>
    </div>
    <div style="background-color: #f9f9f9; padding: 16px; font-size: 12px; color: #777; text-align: center;">
      &copy; ${new Date().getFullYear()} Task Manager App. All rights reserved.
    </div>
  </div>
  `;

    await this.transporter.sendMail({
      from: '"Support App" <support@example.com>',
      to,
      subject: 'Reset Password',
      html: htmlContent,
    });
  }
}
