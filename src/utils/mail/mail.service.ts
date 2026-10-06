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
    this.domain =
      process.env.NODE_ENV === 'production'
        ? (process.env.FRONTEND_URL as string)
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

  // =========================================================
  // 🔹 Helpers umum (DRY)
  // =========================================================

  /** Escape HTML sederhana */
  private esc(s: string): string {
    return s.replace(
      /[&<>"']/g,
      (ch) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[ch]!,
    );
  }

  /** Build URL project secara robust dengan fallback */
  private buildProjectUrl(projectId: string): string {
    const base = this.domain || 'http://localhost:3000';
    try {
      return new URL(`/dashboard/projects/${projectId}`, base).toString();
    } catch {
      const sep = base.endsWith('/') ? '' : '/';
      return `${base}${sep}dashboard/projects/${projectId}`;
    }
  }

  /** Build URL task dengan query param ?taskId=... */
  private buildTaskUrl(projectId: string, taskId?: string): string {
    const projectUrl = this.buildProjectUrl(projectId);
    if (!taskId) return projectUrl;
    return `${projectUrl}?taskId=${encodeURIComponent(taskId)}`;
  }

  /** Build URL dashboard */
  private buildDashboardUrl(): string {
    const base = this.domain || 'http://localhost:3000';
    try {
      return new URL('/dashboard', base).toString();
    } catch {
      const sep = base.endsWith('/') ? '' : '/';
      return `${base}${sep}dashboard`;
    }
  }

  /** Format tanggal ke bahasa Indonesia */
  private formatDateIndo(date: Date | string): string {
    try {
      const d = typeof date === 'string' ? new Date(date) : date;
      if (isNaN(d.getTime())) return String(date);
      return new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Jakarta',
      }).format(d);
    } catch {
      return String(date);
    }
  }

  private formatDateOnlyIndo(date: Date | string): string {
    try {
      const d = typeof date === 'string' ? new Date(date) : date;
      if (isNaN(d.getTime())) return String(date);
      return new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeZone: 'Asia/Jakarta',
      }).format(d);
    } catch {
      return String(date);
    }
  }

  /** Normalisasi penerima jadi string[] dan buang empty string */
  private normalizeRecipients(to: string | string[]): string[] {
    return (Array.isArray(to) ? to : [to]).filter((v): v is string => !!v && v.trim().length > 0);
  }

  // =========================================================
  // 🔹 RESET PASSWORD
  // =========================================================

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

  // =========================================================
  // 🔹 PASSWORD CHANGED NOTIFICATION
  // =========================================================

  /** Kirim email notifikasi bahwa kata sandi telah berhasil diubah */
  async sendPasswordChangedEmail(to: string, userName?: string): Promise<void> {
    const recipients = this.normalizeRecipients(to);
    if (!recipients.length) return;

    const name = userName ? this.esc(userName) : 'Pengguna';
    const loginUrl = `${this.domain || 'https://workspace.amscorp.id'}/login`;
    const changeTime = this.formatDateIndo(new Date());

    const htmlContent = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
    <div style="background-color: #4f46e5; padding: 20px; color: white;">
      <h2 style="margin: 0;">🛡️ Keamanan Akun: Kata Sandi Diperbarui</h2>
    </div>
    <div style="padding: 24px; color: #333; line-height: 1.6;">
      <p style="font-size: 15px;">Halo <strong>${name}</strong>,</p>
      <p>Kata sandi untuk akun <strong>Task Manager</strong> Anda telah berhasil diperbarui pada <strong>${changeTime} WIB</strong>.</p>

      <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 14px 16px; margin: 18px 0; color: #166534; font-size: 14px;">
        ✅ <strong>Kata sandi Anda telah berhasil diganti.</strong> Anda dapat masuk kembali ke dashboard menggunakan kata sandi baru.
      </div>

      <div style="text-align: center; margin: 24px 0;">
        <a href="${loginUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
          Masuk ke Akun
        </a>
      </div>

      <div style="border-top: 1px solid #eee; margin-top: 20px; padding-top: 16px;">
        <p style="font-size: 13px; color: #b91c1c; margin: 0 0 4px 0; font-weight: bold;">
          ⚠️ Bukan Anda yang melakukan perubahan ini?
        </p>
        <p style="font-size: 12px; color: #666; margin: 0;">
          Jika Anda tidak pernah meminta perubahan kata sandi, akun Anda mungkin telah disusupi. Segera atur ulang kata sandi Anda melalui menu <em>Lupa Kata Sandi</em> pada halaman login atau hubungi tim IT Administrator.
        </p>
      </div>
    </div>
    <div style="background-color: #f9f9f9; padding: 16px; font-size: 12px; color: #777; text-align: center; border-top: 1px solid #eee;">
      &copy; ${new Date().getFullYear()} Task Manager App. All rights reserved.
    </div>
  </div>
  `;

    try {
      await this.mailer.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients,
        subject: 'Keamanan Akun: Kata Sandi Anda Telah Diperbarui',
        html: htmlContent,
      });
    } catch (e) {
      // jangan block flow utama
      this.logger.warn(`sendPasswordChangedEmail failed: ${e}`);
    }
  }

  // =========================================================
  // 🔹 PROJECT: JOINED
  // =========================================================

  /** Kirim email notifikasi bergabung ke project */
  async sendProjectJoinedEmail(params: {
    to: string | string[];
    projectId: string;
    projectName: string;
    role?: 'OWNER' | 'EDITOR' | 'READ';
  }): Promise<void> {
    const { to, projectId, projectName, role } = params;

    const recipients = this.normalizeRecipients(to);
    if (!recipients.length) return;

    const projectUrl = this.buildProjectUrl(projectId);
    const projectNameEsc = this.esc(projectName);
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
 
      <div style="text-align:center; margin:16px 0;">
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
            ${role ?? ''}
          </span>
        </div>
      </div>

      <div style="text-align: center; margin: 24px 0;">
        <a href="${projectUrl}" style="background-color: #1a3768; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Buka Project
        </a>
      </div>

      <p style="font-size: 12px; color:#475569;text-align: center">
        Jika tombol tidak berfungsi, salin dan tempel URL berikut ke browser Anda:
      </p>
      <p style="font-size: 12px;word-break: break-all; color:#0f172a;text-align: center">
        ${projectUrl}
      </p>
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
        to: recipients,
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

  // =========================================================
  // 🔹 PROJECT: ROLE CHANGED
  // =========================================================

  /** Kirim email notifikasi ROLE DIUBAH di project */
  async sendProjectRoleChangedEmail(params: {
    to: string | string[];
    projectId: string;
    projectName: string;
    oldRole: 'OWNER' | 'EDITOR' | 'READ';
    newRole: 'OWNER' | 'EDITOR' | 'READ';
  }): Promise<void> {
    const { to, projectId, projectName, oldRole, newRole } = params;

    const recipients = this.normalizeRecipients(to);
    if (!recipients.length) return;

    const projectUrl = this.buildProjectUrl(projectId);
    const projectNameEsc = this.esc(projectName);
    const year = new Date().getFullYear();

    const htmlContent = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
    <div style="background-color: #1a3768; padding: 20px; color: white;">
      <h2 style="margin: 0;">Peran Anda di Project Berubah</h2>
    </div>

    <div style="padding: 20px;">
      <p>Halo, peran Anda di project berikut telah diperbarui:</p>

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

      <div style="text-align:center; margin:16px 0;">
        <span style="display:inline-block; font-size:12px; color:#475569;">Peran sebelumnya:</span>
        <div style="
          display:inline-block;
          background-color:#fee2e2;
          border:1px solid #fecaca;
          border-radius:999px;
          padding:6px 12px;
          margin-left:8px;
        ">
          <span style="font-weight:600; font-size:12px; color:#b91c1c;">
            ${oldRole}
          </span>
        </div>
      </div>

      <div style="text-align:center; margin:8px 0 24px 0;">
        <span style="display:inline-block; font-size:12px; color:#475569;">Peran baru:</span>
        <div style="
          display:inline-block;
          background-color:#ecfdf5;
          border:1px solid #bbf7d0;
          border-radius:999px;
          padding:6px 12px;
          margin-left:8px;
        ">
          <span style="font-weight:600; font-size:12px; color:#166534;">
            ${newRole}
          </span>
        </div>
      </div>

      <div style="text-align: center; margin: 24px 0;">
        <a href="${projectUrl}" style="background-color: #1a3768; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Buka Project
        </a>
      </div>

      <p style="font-size: 12px; color:#475569;text-align: center">
        Jika tombol tidak berfungsi, salin dan tempel URL berikut ke browser Anda:
      </p>
      <p style="font-size: 12px;word-break: break-all; color:#0f172a;text-align: center">
        ${projectUrl}
      </p>
    </div>

    <div style="background-color: #f9f9f9; padding: 16px; font-size: 12px; color: #777; text-align: center;">
      ${year} Task Manager App.
    </div>
  </div>
  `;

    const subject = `Peran Anda di project "${projectNameEsc}" telah diubah`;

    try {
      await this.mailer.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients,
        subject,
        html: htmlContent,
        text:
          `Peran Anda di project "${projectName}" telah diubah ` +
          `dari ${oldRole} menjadi ${newRole}. ` +
          `Buka project: ${projectUrl}`,
      });
    } catch (e) {
      this.logger.warn(`sendProjectRoleChangedEmail failed: ${e}`);
    }
  }

  // =========================================================
  // 🔹 PROJECT: ACCESS REVOKED
  // =========================================================

  /** Kirim email notifikasi AKSES DICABUT dari project */
  async sendProjectAccessRevokedEmail(params: {
    to: string | string[];
    projectId: string;
    projectName: string;
  }): Promise<void> {
    const { to, projectId, projectName } = params;

    const recipients = this.normalizeRecipients(to);
    if (!recipients.length) return;

    const projectUrl = this.buildProjectUrl(projectId); // optional, cuma dipakai di text
    const projectNameEsc = this.esc(projectName);
    const year = new Date().getFullYear();

    const htmlContent = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
    <div style="background-color: #1a3768; padding: 20px; color: white;">
      <h2 style="margin: 0;">Akses Project Dicabut</h2>
    </div>

    <div style="padding: 20px;">
      <p>Halo, akses Anda ke project berikut telah dicabut:</p>

      <div style="
        text-align:center;
        background-color:#fef2f2;
        border:1px solid #fee2e2;
        border-radius:8px;
        padding:16px;
        margin:16px 0;
      ">
        <p style="margin:0 0 8px 0;"><strong>${projectNameEsc}</strong></p>
      </div>

      <p style="font-size: 13px; color:#475569;">
        Jika Anda merasa ini adalah kesalahan, silakan hubungi owner project atau administrator sistem.
      </p>
    </div>

    <div style="background-color: #f9f9f9; padding: 16px; font-size: 12px; color: #777; text-align: center;">
      ${year} Task Manager App.
    </div>
  </div>
  `;

    const subject = `Akses Anda ke project "${projectNameEsc}" telah dicabut`;

    try {
      await this.mailer.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients,
        subject,
        html: htmlContent,
        text:
          `Akses Anda ke project "${projectName}" telah dicabut. ` +
          `Jika ini tidak sesuai, hubungi owner project. ` +
          `(Project URL: ${projectUrl})`,
      });
    } catch (e) {
      this.logger.warn(`sendProjectAccessRevokedEmail failed: ${e}`);
    }
  }

  // =========================================================
  // 🔹 TASK / SUBTASK: ASSIGNED
  // =========================================================

  /** Kirim email notifikasi saat user ditugaskan ke task / subtask */
  async sendTaskAssignedEmail(params: {
    to: string | string[];
    taskId: string;
    taskName: string;
    projectId: string;
    projectName: string;
    assignedByName: string;
    dueDate?: Date | string | null;
    isSubtask?: boolean;
  }): Promise<void> {
    const { to, taskId, taskName, projectId, projectName, assignedByName, dueDate, isSubtask } =
      params;
    const recipients = this.normalizeRecipients(to);
    if (!recipients.length) return;

    const taskUrl = this.buildTaskUrl(projectId, taskId);
    const taskNameEsc = this.esc(taskName);
    const projectNameEsc = this.esc(projectName);
    const assignedByNameEsc = this.esc(assignedByName);
    const itemLabel = isSubtask ? 'Subtask' : 'Task';
    const year = new Date().getFullYear();
    const dueDateStr = dueDate ? this.formatDateIndo(dueDate) : null;

    const htmlContent = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
    <div style="background-color: #1a3768; padding: 20px; color: white;">
      <h2 style="margin: 0; font-size: 20px;">📋 ${itemLabel} Baru Ditugaskan</h2>
    </div>

    <div style="padding: 24px 20px;">
      <p style="font-size: 15px; color: #334155; margin-top: 0;">Halo,</p>
      <p style="font-size: 14px; color: #334155; line-height: 1.5;">
        <strong>${assignedByNameEsc}</strong> telah menugaskan Anda pada ${itemLabel.toLowerCase()} berikut di project <strong>${projectNameEsc}</strong>:
      </p>

      <div style="
        background-color: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 16px;
        margin: 20px 0;
      ">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; font-weight: 600; margin-bottom: 4px;">PROJECT</div>
        <div style="font-size: 14px; font-weight: 600; color: #0f172a; margin-bottom: 12px;">${projectNameEsc}</div>

        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; font-weight: 600; margin-bottom: 4px;">${itemLabel.toUpperCase()}</div>
        <div style="font-size: 16px; font-weight: bold; color: #1e293b;">${taskNameEsc}</div>

        ${
          dueDateStr
            ? `<div style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #cbd5e1; font-size: 13px; color: #475569;">
                ⏰ <strong>Tenggat Waktu:</strong> ${dueDateStr}
               </div>`
            : ''
        }
      </div>

      <div style="text-align: center; margin: 28px 0 20px 0;">
        <a href="${taskUrl}" style="background-color: #1a3768; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
          Buka ${itemLabel}
        </a>
      </div>

      <p style="font-size: 12px; color: #64748b; text-align: center; margin-bottom: 4px;">
        Jika tombol tidak berfungsi, salin dan tempel tautan berikut ke peramban Anda:
      </p>
      <p style="font-size: 12px; word-break: break-all; color: #0f172a; text-align: center; margin-top: 0;">
        ${taskUrl}
      </p>
    </div>

    <div style="background-color: #f9f9f9; padding: 16px; font-size: 12px; color: #777; text-align: center; border-top: 1px solid #e0e0e0;">
      &copy; ${year} Task Manager App. All rights reserved.
    </div>
  </div>
  `;

    const subject = `Anda ditugaskan pada ${itemLabel.toLowerCase()} "${taskNameEsc}" di project "${projectNameEsc}"`;

    try {
      await this.mailer.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients,
        subject,
        html: htmlContent,
        text:
          `Anda telah ditugaskan oleh ${assignedByName} pada ${itemLabel} "${taskName}" di project "${projectName}".\n` +
          (dueDateStr ? `Tenggat Waktu: ${dueDateStr}\n` : '') +
          `Buka: ${taskUrl}`,
      });
      this.logger.log(
        `📧 Task assigned email sent to [${recipients.join(', ')}] for task "${taskName}"`,
      );
    } catch (e) {
      this.logger.warn(`sendTaskAssignedEmail failed: ${e}`);
    }
  }

  // =========================================================
  // 🔹 DUE DATE REMINDER & OVERDUE
  // =========================================================

  /** Kirim email pengingat tenggat waktu / overdue untuk task tertentu */
  async sendDueDateReminderEmail(params: {
    to: string | string[];
    userName?: string;
    taskId: string;
    taskName: string;
    projectId: string;
    projectName: string;
    dueDate: Date | string;
    isOverdue?: boolean;
    daysDiff?: number;
  }): Promise<void> {
    const {
      to,
      userName,
      taskId,
      taskName,
      projectId,
      projectName,
      dueDate,
      isOverdue,
      daysDiff,
    } = params;
    const recipients = this.normalizeRecipients(to);
    if (!recipients.length) return;

    const taskUrl = this.buildTaskUrl(projectId, taskId);
    const taskNameEsc = this.esc(taskName);
    const projectNameEsc = this.esc(projectName);
    const userNameEsc = this.esc(userName || 'Rekan');
    const dueDateStr = this.formatDateIndo(dueDate);
    const year = new Date().getFullYear();

    const headerBg = isOverdue ? '#b91c1c' : '#d97706';
    const headerTitle = isOverdue
      ? '⚠️ Peringatan: Task Melewati Deadline'
      : '⏰ Pengingat: Task Jatuh Tempo';
    const badgeBg = isOverdue ? '#fee2e2' : '#fef3c7';
    const badgeColor = isOverdue ? '#b91c1c' : '#92400e';
    const badgeText = isOverdue
      ? `Terlambat ${daysDiff ?? 1} hari`
      : daysDiff === 0
      ? 'Jatuh tempo HARI INI'
      : 'Jatuh tempo BESOK';

    const htmlContent = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
    <div style="background-color: ${headerBg}; padding: 20px; color: white;">
      <h2 style="margin: 0; font-size: 20px;">${headerTitle}</h2>
    </div>

    <div style="padding: 24px 20px;">
      <p style="font-size: 15px; color: #334155; margin-top: 0;">Halo <strong>${userNameEsc}</strong>,</p>
      <p style="font-size: 14px; color: #334155; line-height: 1.5;">
        ${
          isOverdue
            ? `Tugas berikut telah <strong>melewati batas waktu pengerjaan</strong> dan memerlukan perhatian segera:`
            : `Tugas berikut akan segera <strong>jatuh tempo</strong>. Mohon periksa dan selesaikan sebelum tenggat waktu:`
        }
      </p>

      <div style="
        background-color: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 16px;
        margin: 20px 0;
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; font-weight: 600;">PROJECT: ${projectNameEsc}</span>
        </div>

        <div style="font-size: 16px; font-weight: bold; color: #1e293b; margin-bottom: 12px;">
          ${taskNameEsc}
        </div>

        <div style="margin-bottom: 8px;">
          <span style="background-color: ${badgeBg}; color: ${badgeColor}; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: bold;">
            ${badgeText}
          </span>
        </div>

        <div style="font-size: 13px; color: #475569; margin-top: 10px;">
          📅 <strong>Tenggat Waktu:</strong> ${dueDateStr}
        </div>
      </div>

      <div style="text-align: center; margin: 28px 0 20px 0;">
        <a href="${taskUrl}" style="background-color: ${
          isOverdue ? '#b91c1c' : '#1a3768'
        }; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
          ${isOverdue ? 'Selesaikan Task Sekarang' : 'Lihat Detail Task'}
        </a>
      </div>

      <p style="font-size: 12px; color: #64748b; text-align: center; margin-bottom: 4px;">
        Tautan langsung ke task:
      </p>
      <p style="font-size: 12px; word-break: break-all; color: #0f172a; text-align: center; margin-top: 0;">
        ${taskUrl}
      </p>
    </div>

    <div style="background-color: #f9f9f9; padding: 16px; font-size: 12px; color: #777; text-align: center; border-top: 1px solid #e0e0e0;">
      &copy; ${year} Task Manager App. All rights reserved.
    </div>
  </div>
  `;

    const subject = isOverdue
      ? `⚠️ [OVERDUE] Task "${taskNameEsc}" telah melewati deadline`
      : `⏰ [REMINDER] Task "${taskNameEsc}" jatuh tempo (${badgeText})`;

    try {
      await this.mailer.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients,
        subject,
        html: htmlContent,
        text:
          `${isOverdue ? 'PERINGATAN OVERDUE' : 'REMINDER TENGGAT WAKTU'}\n` +
          `Task: "${taskName}" (${projectName})\n` +
          `Deadline: ${dueDateStr}\n` +
          `Status: ${badgeText}\n` +
          `Buka task: ${taskUrl}`,
      });
      this.logger.log(`📧 Due date email sent to [${recipients.join(', ')}] for task "${taskName}"`);
    } catch (e) {
      this.logger.warn(`sendDueDateReminderEmail failed: ${e}`);
    }
  }

  // =========================================================
  // 🔹 DAILY MORNING BRIEFING / DIGEST
  // =========================================================

  /** Kirim email ringkasan tugas harian untuk satu user */
  async sendDailyDigestEmail(params: {
    to: string;
    userName: string;
    dueToday: Array<{
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      dueDate?: Date | string | null;
    }>;
    overdue: Array<{
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      daysOverdue: number;
    }>;
    totalActiveTasks: number;
  }): Promise<void> {
    const { to, userName, dueToday, overdue, totalActiveTasks } = params;
    if (!to || !to.trim()) return;

    const userNameEsc = this.esc(userName || 'Rekan');
    const dashboardUrl = this.buildDashboardUrl();
    const todayStr = this.formatDateOnlyIndo(new Date());
    const year = new Date().getFullYear();

    const overdueHtml =
      overdue.length > 0
        ? `
      <div style="margin-bottom: 24px;">
        <div style="font-size: 14px; font-weight: bold; color: #b91c1c; margin-bottom: 10px;">
          ⚠️ Perlu Perhatian Segera (Melewati Deadline - ${overdue.length})
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          ${overdue
            .map((item) => {
              const url = this.buildTaskUrl(item.projectId, item.id);
              return `
            <tr style="border-bottom: 1px solid #fee2e2; background-color: #fff5f5;">
              <td style="padding: 10px 12px;">
                <div style="font-weight: 600; color: #0f172a;">${this.esc(item.name)}</div>
                <div style="font-size: 11px; color: #64748b;">${this.esc(
                  item.projectName,
                )} &bull; <span style="color: #b91c1c; font-weight: bold;">Terlambat ${
                item.daysOverdue
              } hari</span></div>
              </td>
              <td style="padding: 10px 12px; text-align: right; white-space: nowrap;">
                <a href="${url}" style="color: #b91c1c; text-decoration: none; font-weight: bold;">Buka &rarr;</a>
              </td>
            </tr>
          `;
            })
            .join('')}
        </table>
      </div>
    `
        : '';

    const dueTodayHtml =
      dueToday.length > 0
        ? `
      <div style="margin-bottom: 24px;">
        <div style="font-size: 14px; font-weight: bold; color: #b45309; margin-bottom: 10px;">
          ⏰ Jatuh Tempo Hari Ini (${dueToday.length})
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          ${dueToday
            .map((item) => {
              const url = this.buildTaskUrl(item.projectId, item.id);
              return `
            <tr style="border-bottom: 1px solid #fef3c7; background-color: #fffbeb;">
              <td style="padding: 10px 12px;">
                <div style="font-weight: 600; color: #0f172a;">${this.esc(item.name)}</div>
                <div style="font-size: 11px; color: #64748b;">${this.esc(item.projectName)}</div>
              </td>
              <td style="padding: 10px 12px; text-align: right; white-space: nowrap;">
                <a href="${url}" style="color: #d97706; text-decoration: none; font-weight: bold;">Buka &rarr;</a>
              </td>
            </tr>
          `;
            })
            .join('')}
        </table>
      </div>
    `
        : '';

    const htmlContent = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
    <div style="background-color: #1e293b; padding: 20px; color: white;">
      <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; margin-bottom: 4px;">DAILY STANDUP BRIEFING</div>
      <h2 style="margin: 0; font-size: 20px;">☀️ Rangkuman Tugas Hari Ini</h2>
      <div style="font-size: 13px; color: #cbd5e1; margin-top: 4px;">${todayStr}</div>
    </div>

    <div style="padding: 24px 20px;">
      <p style="font-size: 15px; color: #334155; margin-top: 0;">Halo <strong>${userNameEsc}</strong>,</p>
      <p style="font-size: 14px; color: #334155; line-height: 1.5;">
        Berikut adalah ringkasan fokus tugas Anda untuk hari ini agar target kerja tim tetap tercapai:
      </p>

      <!-- Metric Badges -->
      <table style="width: 100%; border-collapse: separate; border-spacing: 8px; margin: 16px 0 24px 0;">
        <tr>
          <td style="background-color: ${
            overdue.length > 0 ? '#fee2e2' : '#f1f5f9'
          }; border: 1px solid ${
      overdue.length > 0 ? '#fca5a5' : '#e2e8f0'
    }; border-radius: 6px; padding: 12px; text-align: center; width: 33%;">
            <div style="font-size: 22px; font-weight: bold; color: ${
              overdue.length > 0 ? '#b91c1c' : '#475569'
            };">${overdue.length}</div>
            <div style="font-size: 11px; font-weight: 600; color: ${
              overdue.length > 0 ? '#b91c1c' : '#64748b'
            }; text-transform: uppercase;">Overdue</div>
          </td>
          <td style="background-color: ${
            dueToday.length > 0 ? '#fef3c7' : '#f1f5f9'
          }; border: 1px solid ${
      dueToday.length > 0 ? '#fcd34d' : '#e2e8f0'
    }; border-radius: 6px; padding: 12px; text-align: center; width: 33%;">
            <div style="font-size: 22px; font-weight: bold; color: ${
              dueToday.length > 0 ? '#b45309' : '#475569'
            };">${dueToday.length}</div>
            <div style="font-size: 11px; font-weight: 600; color: ${
              dueToday.length > 0 ? '#b45309' : '#64748b'
            }; text-transform: uppercase;">Hari Ini</div>
          </td>
          <td style="background-color: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; text-align: center; width: 33%;">
            <div style="font-size: 22px; font-weight: bold; color: #1e293b;">${totalActiveTasks}</div>
            <div style="font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase;">Total Aktif</div>
          </td>
        </tr>
      </table>

      ${overdueHtml}
      ${dueTodayHtml}

      <div style="text-align: center; margin: 28px 0 20px 0;">
        <a href="${dashboardUrl}" style="background-color: #1a3768; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
          Buka Dashboard & Tugas Saya
        </a>
      </div>
    </div>

    <div style="background-color: #f9f9f9; padding: 16px; font-size: 12px; color: #777; text-align: center; border-top: 1px solid #e0e0e0;">
      &copy; ${year} Task Manager App. All rights reserved.
    </div>
  </div>
  `;

    const subject = `☀️ [Daily Briefing] Rangkuman Tugas Anda (${todayStr}) - ${overdue.length} Overdue, ${dueToday.length} Hari Ini`;

    try {
      await this.mailer.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to,
        subject,
        html: htmlContent,
        text:
          `Daily Briefing (${todayStr})\n` +
          `Overdue: ${overdue.length} | Hari ini: ${dueToday.length} | Total Aktif: ${totalActiveTasks}\n` +
          `Buka dashboard: ${dashboardUrl}`,
      });
      this.logger.log(`📧 Daily digest email sent to ${to}`);
    } catch (e) {
      this.logger.warn(`sendDailyDigestEmail failed to ${to}: ${e}`);
    }
  }

  // =========================================================
  // 🔹 PROJECT: 100% COMPLETED MILESTONE
  // =========================================================

  /** Kirim email notifikasi ketika seluruh task di project telah selesai 100% */
  async sendProjectCompletedEmail(params: {
    to: string | string[];
    projectId: string;
    projectName: string;
    totalTasks: number;
  }): Promise<void> {
    const { to, projectId, projectName, totalTasks } = params;
    const recipients = this.normalizeRecipients(to);
    if (!recipients.length) return;

    const projectUrl = this.buildProjectUrl(projectId);
    const projectNameEsc = this.esc(projectName);
    const year = new Date().getFullYear();

    const htmlContent = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
    <div style="background-color: #059669; padding: 20px; color: white;">
      <h2 style="margin: 0; font-size: 20px;">🎉 Selamat! Seluruh Tugas Selesai</h2>
    </div>

    <div style="padding: 24px 20px;">
      <p style="font-size: 15px; color: #334155; margin-top: 0;">Halo Tim,</p>
      <p style="font-size: 14px; color: #334155; line-height: 1.5;">
        Kabar gembira! Seluruh tugas dalam project berikut telah <strong>100% selesai dikerjakan</strong>:
      </p>

      <div style="
        background-color: #ecfdf5;
        border: 1px solid #a7f3d0;
        border-radius: 8px;
        padding: 20px;
        margin: 20px 0;
        text-align: center;
      ">
        <div style="font-size: 18px; font-weight: bold; color: #065f46; margin-bottom: 6px;">${projectNameEsc}</div>
        <div style="display: inline-block; background-color: #10b981; color: white; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: bold;">
          ${totalTasks} dari ${totalTasks} Task Selesai (100%)
        </div>
      </div>

      <div style="text-align: center; margin: 28px 0 20px 0;">
        <a href="${projectUrl}" style="background-color: #059669; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
          Lihat Project
        </a>
      </div>

      <p style="font-size: 12px; color: #64748b; text-align: center; margin-bottom: 4px;">
        Tautan project:
      </p>
      <p style="font-size: 12px; word-break: break-all; color: #0f172a; text-align: center; margin-top: 0;">
        ${projectUrl}
      </p>
    </div>

    <div style="background-color: #f9f9f9; padding: 16px; font-size: 12px; color: #777; text-align: center; border-top: 1px solid #e0e0e0;">
      &copy; ${year} Task Manager App. All rights reserved.
    </div>
  </div>
  `;

    const subject = `🎉 Selamat! Seluruh task di project "${projectNameEsc}" telah selesai (100%)`;

    try {
      await this.mailer.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: recipients,
        subject,
        html: htmlContent,
        text:
          `Selamat! Seluruh tugas (${totalTasks} task) di project "${projectName}" telah selesai 100%.\n` +
          `Buka project: ${projectUrl}`,
      });
      this.logger.log(
        `📧 Project completed email sent to [${recipients.join(', ')}] for project "${projectName}"`,
      );
    } catch (e) {
      this.logger.warn(`sendProjectCompletedEmail failed: ${e}`);
    }
  }
}

