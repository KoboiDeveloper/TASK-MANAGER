// src/mail/mail.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly fromName: string;
  private readonly fromEmail: string;
  readonly domain: string;

  constructor(
    private readonly mailer: MailerService,
    private readonly cfg: ConfigService,
  ) {
    this.domain = this.domain =
      process.env.NODE_ENV === 'production'
        ? (process.env.FRONTEND_URL as string) // wajib isi di server
        : (process.env.FRONTEND_URL ?? 'http://localhost:3000');
    this.fromName = this.cfg.get<string>('SMTP_FROM_NAME') || 'Task Manager';
    this.fromEmail =
      this.cfg.get<string>('SMTP_FROM_EMAIL') ||
      this.cfg.get<string>('SMTP_USER') ||
      'no-reply@example.com';
  }

  async onModuleInit() {
    try {
      // Ambil transporter tanpa tipe 'any'
      const transporter: unknown = (this.mailer as unknown as { transporter?: unknown })
        .transporter;

      // Type guard aman (tanpa any)
      const hasVerify = (v: unknown): v is { verify: () => Promise<unknown> } => {
        return (
          typeof v === 'object' &&
          v !== null &&
          'verify' in v &&
          typeof (v as { verify?: unknown }).verify === 'function'
        );
      };

      if (hasVerify(transporter)) {
        await transporter.verify();
        this.logger.log('SMTP transporter verified.');
      }
    } catch (e) {
      this.logger.warn(`SMTP verify failed: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  /** Kirim email reset password (OTP + link) */
  async sendResetPasswordEmail(to: string, token: string, otp: string): Promise<void> {
    const resetUrl = `${this.domain}/reset-password?verifylink=${encodeURIComponent(token)}`;

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

    try {
      await this.mailer.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to,
        subject: 'Reset Password',
        html: htmlContent,
      });
    } catch (e) {
      // jangan block flow utama
      this.logger.warn(`sendResetPasswordEmail failed: ${e}`);
    }
  }

  /** Kirim email notifikasi bergabung ke project */
  async sendProjectJoinedEmail(params: {
    to: string | string[];
    projectId: string;
    projectName: string;
    role?: 'OWNER' | 'EDITOR' | 'READ';
  }): Promise<void> {
    const { to, projectId, projectName, role } = params;

    // Normalisasi penerima
    const recipients = (Array.isArray(to) ? to : [to]).filter(
      (v): v is string => v.trim().length > 0,
    );
    if (!recipients.length) return;

    // Bangun URL project robust
    const base = this.domain || 'http://localhost:3000';
    let projectUrl = '';
    try {
      projectUrl = new URL(`/dashboard/projects/${projectId}`, base).toString();
    } catch {
      const sep = base.endsWith('/') ? '' : '/';
      projectUrl = `${base}${sep}dashboard/projects/${projectId}`;
    }

    // Escape HTML sederhana untuk nama project
    const esc = (s: string) =>
      s.replace(
        /[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
      );
    const projectNameEsc = esc(projectName);

    const year = new Date().getFullYear();

    const htmlContent = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
    <div style="background-color: #1a3768; padding: 20px; color: white;">
      <h2 style="margin: 0;">Telah Bergabung ke Project</h2>
    </div>

    <div style="padding: 20px;">
      <p>Halo, Anda sekarang <strong>telah bergabung</strong> di project berikut:</p>

      <div style="
  text-align:center;
  background-color:#f8fafc;
  border:1px solid #e2e8f0;
  border-radius:8px;
  padding:16px;
  margin:16px 0;
">
  <p style="margin:0 0 8px 0;"><strong>${projectNameEsc}</strong></p>
</div>
 
     <div style="
    text-align:center;
    margin:16px 0;
  ">
    <div style="
      display:inline-block;
      background-color:#f8fafc;
      border:1px solid #e2e8f0;
  border-radius:8px;      
      padding:6px 12px;
      width:auto;                
      white-space:nowrap; 
      line-height:1;
    ">
      <span style="font-weight:600; font-size:12px; color:#0f172a;">
        ${role}
      </span>
    </div>
  </div>

      <div style="text-align: center; margin: 24px 0;">
        <a href="${projectUrl}" style="background-color: #1a3768; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Buka Project
        </a>
      </div>

      <p style="font-size: 12px; color:#475569;text-align: center">Jika tombol tidak berfungsi, salin dan tempel URL berikut ke browser Anda:</p>
      <p style="font-size: 12px;word-break: break-all; color:#0f172a;text-align: center">${projectUrl}</p>
    </div>

    <div style="background-color: #f9f9f9; padding: 16px; font-size: 12px; color: #777; text-align: center;">
	 ${year} Task Manager App.
    </div>
  </div>
  `;

    const subject = `Anda telah bergabung di project "${projectNameEsc}"`;

    try {
      await this.mailer.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients, // string[] aman di Nodemailer
        subject,
        html: htmlContent,
        text:
          `Anda telah bergabung di project "${projectName}"` +
          (role ? ` sebagai ${role}` : '') +
          `. Buka project: ${projectUrl}`,
      });
    } catch (e) {
      this.logger.warn(`sendProjectJoinedEmail failed: ${e}`);
    }
  }
}
