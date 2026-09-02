const jwt = require("../services/jwt");
const { isIpAllowed, parseAllowList, validateAllowList } = require("../utils/ip");
// const SMS = require("../services/sms");

/** Returned when a valid login is refused because of where it came from. */
const IP_NOT_ALLOWED = {
  code: 403,
  error: "IP_NOT_ALLOWED",
  msg: "This account can only be used from an approved network.",
};

class UserUsecase {
  constructor(userRepo, designationRepo, employeeRepo) {
    this.userRepo = userRepo;
    this.designationRepo = designationRepo;
    this.employeeRepo = employeeRepo;
  }

  /**
   * Sign in.
   *
   * `clientIp` is the address the request came from. When the account has an
   * IP allow-list configured, a login from anywhere else is refused even
   * though the credentials are correct.
   */
  login(username, password, clientIp) {
    return new Promise(async (resolve, reject) => {
      try {
        const details = await this.userRepo.login(username, password);
        const name = await this.employeeRepo.getNameById(username);
        if (details.length === 0) {
          resolve({ code: 204 });
          return;
        }

        if (!isIpAllowed(clientIp, details[0].allowed_ips)) {
          resolve({ ...IP_NOT_ALLOWED, ip: clientIp });
          return;
        }

        const info = {};
        info.id = details[0].user_id;
        info.store_id = details[0].store_id;
        info.designation_id = details[0].designation_id;
        info.employee_id = details[0].employee_id;
        info.user_type = details[0].user_type;
        info.name = name[0]?.employee_name;
        info.designation = name[0]?.designation_name;
        info.employee_image = name[0]?.employee_image;

        const token = await jwt.sign(info, "1d");
        resolve({
          code: 200,
          token: token,
          store_id: info.store_id,
          designation_id: info.designation_id,
          employee_id: info.employee_id,
          user_type: info.user_type,
          name: info.name,
          designation: info.designation,
          employee_image: info.employee_image,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** The allow-list for one user, as an array. Empty means unrestricted. */
  async getAllowedIps(userId) {
    const raw = await this.userRepo.getAllowedIps(userId);
    return parseAllowList(raw);
  }

  /** Every active login with its allow-list, for the admin screen. */
  async getIpRestrictions() {
    const rows = await this.userRepo.getIpRestrictions();
    return (rows || []).map((row) => ({
      ...row,
      allowed_ips: parseAllowList(row.allowed_ips),
      is_restricted: parseAllowList(row.allowed_ips).length > 0,
    }));
  }

  /**
   * Replace a user's allow-list.
   *
   * An empty list clears the restriction. Entries are validated first so a
   * typo cannot silently lock someone out of every network.
   */
  async updateAllowedIps(userId, allowedIps) {
    const { valid, invalid, rules } = validateAllowList(allowedIps);
    if (!valid) {
      const error = new Error(
        `Invalid IP entries: ${invalid.join(", ")}`
      );
      error.name = "ValidationError";
      throw error;
    }

    const value = rules.length === 0 ? null : rules.join(", ");
    await this.userRepo.updateAllowedIps(userId, value);
    return { code: 200, allowed_ips: rules };
  }
}

module.exports = (userRepo, designationRepo, employeeRepo) => {
  return new UserUsecase(userRepo, designationRepo, employeeRepo);
};
